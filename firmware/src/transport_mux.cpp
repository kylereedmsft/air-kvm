#include "transport_mux.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include <NimBLEDevice.h>
#if defined(ESP32)
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#endif

namespace {
constexpr size_t kBleControlDirectMaxBytes = 180;
constexpr size_t kBleControlChunkFragChars = 96;
constexpr uint8_t kUartFrameMagic0 = 0x41;  // 'A'
constexpr uint8_t kUartFrameMagic1 = 0x4b;  // 'K'
constexpr uint8_t kUartFrameVersion = 0x01;
constexpr uint8_t kUartFrameTypeTransferChunk = 0x01;
constexpr uint8_t kUartFrameTypeControlJson = 0x02;
constexpr uint8_t kUartFrameTypeLogText = 0x03;
constexpr size_t kUartFrameHeaderLen = 14;
constexpr size_t kUartFrameCrcLen = 4;
constexpr size_t kUartFrameMinLen = kUartFrameHeaderLen + kUartFrameCrcLen;

uint32_t Crc32(const uint8_t* data, size_t len) {
  uint32_t crc = 0xFFFFFFFFu;
  for (size_t i = 0; i < len; ++i) {
    crc ^= data[i];
    for (int j = 0; j < 8; ++j) {
      const uint32_t mask = static_cast<uint32_t>(-(static_cast<int32_t>(crc & 1u)));
      crc = (crc >> 1) ^ (0xEDB88320u & mask);
    }
  }
  return ~crc;
}

String ExtractTypeField(const char* payload) {
  if (payload == nullptr) return String("unknown");
  const std::string raw(payload);
  const std::string needle = "\"type\":\"";
  const size_t start = raw.find(needle);
  if (start == std::string::npos) return String("unknown");
  const size_t value_start = start + needle.size();
  const size_t value_end = raw.find('"', value_start);
  if (value_end == std::string::npos || value_end <= value_start) return String("unknown");
  return String(raw.substr(value_start, value_end - value_start).c_str());
}

bool ShouldTraceBleControlForward(const String& type) {
  return type.startsWith("transfer.") || type == "screenshot.request" || type == "state.request";
}
}  // namespace

namespace airkvm::fw {

bool EncodeUartFramedText(
    uint8_t frame_type,
    const String& text,
    uint8_t* out,
    size_t out_capacity,
    size_t* out_len) {
  if (out == nullptr || out_len == nullptr) return false;
  if (frame_type != kUartFrameTypeControlJson && frame_type != kUartFrameTypeLogText) return false;
  const size_t payload_len = text.length();
  if (payload_len == 0) return false;
  if (payload_len > 0xFFFFu) return false;
  if (kUartFrameMinLen + payload_len > out_capacity) return false;

  *out_len = kUartFrameMinLen + payload_len;
  std::memset(out, 0, out_capacity);
  out[0] = kUartFrameMagic0;
  out[1] = kUartFrameMagic1;
  out[2] = kUartFrameVersion;
  out[3] = frame_type;
  out[4] = 0;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = 0;
  out[11] = 0;
  out[12] = static_cast<uint8_t>(payload_len & 0xFFu);
  out[13] = static_cast<uint8_t>((payload_len >> 8) & 0xFFu);
  std::memcpy(out + kUartFrameHeaderLen, text.c_str(), payload_len);
  const uint32_t crc = Crc32(out + 2, kUartFrameHeaderLen - 2 + payload_len);
  const size_t crc_offset = kUartFrameHeaderLen + payload_len;
  out[crc_offset + 0] = static_cast<uint8_t>(crc & 0xFFu);
  out[crc_offset + 1] = static_cast<uint8_t>((crc >> 8) & 0xFFu);
  out[crc_offset + 2] = static_cast<uint8_t>((crc >> 16) & 0xFFu);
  out[crc_offset + 3] = static_cast<uint8_t>((crc >> 24) & 0xFFu);
  return true;
}

void TransportMux::Begin() {
#if defined(ESP32)
  if (tx_queue_ != nullptr) return;
  tx_queue_ = static_cast<void*>(xQueueCreate(128, sizeof(TxFrame)));
  if (tx_queue_ == nullptr) {
    Serial.println("{\"ch\":\"log\",\"msg\":\"fatal:tx_queue_create_failed\"}");
    Serial.flush();
    abort();
  }
  xTaskCreatePinnedToCore(
      &TransportMux::TxTaskMain,
      "airkvm_tx",
      4096,
      this,
      1,
      reinterpret_cast<TaskHandle_t*>(&tx_task_handle_),
      1);
#endif
}

void TransportMux::SetBleTxCharacteristic(NimBLECharacteristic* characteristic) {
  tx_char_ = characteristic;
}

void TransportMux::EmitLog(const String& message) {
  const String escaped = JsonEscape(message);  // Retain prior escaping behavior in log payload.
  TxFrame frame{};
  frame.is_binary = true;
  if (!EncodeUartFramedText(
          kUartFrameTypeLogText,
          escaped,
          frame.binary,
          sizeof(frame.binary),
          &frame.binary_len)) {
    return;
  }
  EnqueueFrame(frame);
}

void TransportMux::EmitControl(const char* payload) {
  if (payload == nullptr) return;
  TxFrame frame{};
  frame.is_binary = true;
  if (!EncodeUartFramedText(
          kUartFrameTypeControlJson,
          String(payload),
          frame.binary,
          sizeof(frame.binary),
          &frame.binary_len)) {
    return;
  }
  EnqueueFrame(frame);

  EmitBleControl(payload);
}

void TransportMux::EmitBinaryFrame(const uint8_t* bytes, size_t len) {
  if (bytes == nullptr || len == 0) return;
  if (len > kMaxBinaryFrameLen) return;
  if (len < kUartFrameMinLen) return;
  if (bytes[0] != kUartFrameMagic0 || bytes[1] != kUartFrameMagic1) return;
  if (bytes[2] != kUartFrameVersion) return;
  if (bytes[3] != kUartFrameTypeTransferChunk) return;
  TxFrame frame{};
  frame.is_binary = true;
  frame.binary_len = len;
  std::memcpy(frame.binary, bytes, len);
  EnqueueFrame(frame);
}

void TransportMux::EmitState(const DeviceState& state) {
  if (state.busy) {
    EmitControl("{\"type\":\"state\",\"busy\":true}");
  } else {
    EmitControl("{\"type\":\"state\",\"busy\":false}");
  }
}

void TransportMux::EnqueueFrame(const TxFrame& frame) {
#if defined(ESP32)
  if (tx_queue_ == nullptr) {
    return;
  }
  const auto queue = reinterpret_cast<QueueHandle_t>(tx_queue_);
  // Single deterministic UART TX path on ESP32: always enqueue for TX task.
  // No direct-write fallback from producer contexts.
  xQueueSend(queue, &frame, portMAX_DELAY);
  return;
#else
  EmitFrameDirect(frame);
#endif
}

void TransportMux::EmitFrameDirect(const TxFrame& frame) {
  if (frame.is_binary) {
    if (frame.binary_len > 0) {
      Serial.write(frame.binary, frame.binary_len);
      Serial.flush();
    }
    return;
  }
  Serial.println(frame.uart_line);
}

String TransportMux::JsonEscape(const String& in) {
  String escaped;
  escaped.reserve(in.length() + 8);
  for (size_t i = 0; i < in.length(); ++i) {
    const char c = in[i];
    if (c == '\\' || c == '"') {
      escaped += '\\';
      escaped += c;
      continue;
    }
    if (c == '\n') {
      escaped += "\\n";
      continue;
    }
    if (c == '\r') {
      escaped += "\\r";
      continue;
    }
    escaped += c;
  }
  return escaped;
}

void TransportMux::EmitBleControl(const char* payload) {
  if (tx_char_ == nullptr || payload == nullptr) return;
  const String type = ExtractTypeField(payload);
  const size_t payload_len = std::strlen(payload);
  if (payload_len <= kBleControlDirectMaxBytes) {
    std::string ble_payload(payload);
    ble_payload.push_back('\n');
    tx_char_->setValue(
        reinterpret_cast<const uint8_t*>(ble_payload.data()), ble_payload.size());
    tx_char_->notify();
    if (ShouldTraceBleControlForward(type)) {
      EmitLog(String("ble.ctrl_notify_sent type=") + type);
    }
    return;
  }
  EmitBleControlChunked(payload);
  if (ShouldTraceBleControlForward(type)) {
    EmitLog(String("ble.ctrl_notify_chunked type=") + type +
            " bytes=" + String(payload_len));
  }
}

String TransportMux::BuildCtrlChunkMessage(uint32_t chunk_id, size_t seq, size_t total, const String& frag) {
  String out = "{\"type\":\"ctrl.chunk\",\"chunk_id\":";
  out += String(chunk_id);
  out += ",\"seq\":";
  out += String(seq);
  out += ",\"total\":";
  out += String(total);
  out += ",\"frag\":\"";
  out += JsonEscape(frag);
  out += "\"}";
  return out;
}

void TransportMux::EmitBleControlChunked(const char* payload) {
  if (tx_char_ == nullptr || payload == nullptr) return;
  const String full(payload);
  const size_t len = full.length();
  const size_t total = (len + kBleControlChunkFragChars - 1) / kBleControlChunkFragChars;
  const uint32_t chunk_id = ble_chunk_id_++;
  for (size_t seq = 0; seq < total; seq += 1) {
    const size_t start = seq * kBleControlChunkFragChars;
    const size_t frag_len = std::min(kBleControlChunkFragChars, len - start);
    const String frag = full.substring(start, start + frag_len);
    const String chunk_msg = BuildCtrlChunkMessage(chunk_id, seq, total, frag);
    std::string ble_payload(chunk_msg.c_str());
    ble_payload.push_back('\n');
    tx_char_->setValue(
        reinterpret_cast<const uint8_t*>(ble_payload.data()), ble_payload.size());
    tx_char_->notify();
  }
}

#if defined(ESP32)
void TransportMux::TxTaskMain(void* arg) {
  auto* mux = static_cast<TransportMux*>(arg);
  if (mux == nullptr) {
    vTaskDelete(nullptr);
    return;
  }
  mux->TxTaskLoop();
}

void TransportMux::TxTaskLoop() {
  if (tx_queue_ == nullptr) {
    vTaskDelete(nullptr);
    return;
  }
  auto queue = reinterpret_cast<QueueHandle_t>(tx_queue_);
  TxFrame frame{};
  while (true) {
    if (xQueueReceive(queue, &frame, portMAX_DELAY) == pdTRUE) {
      EmitFrameDirect(frame);
    }
  }
}
#endif

}  // namespace airkvm::fw
