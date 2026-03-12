#include "transport_mux.hpp"

#include <cstdio>
#include <cstring>

#include <NimBLEDevice.h>
#if defined(ESP32)
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#endif

namespace airkvm::fw {

// ---------------------------------------------------------------------------
// Frame encoder
// ---------------------------------------------------------------------------

bool TransportMux::EncodeFrame(
    uint8_t type, uint16_t transfer_id, uint16_t seq,
    const uint8_t* payload, uint8_t payload_len,
    uint8_t* out, size_t out_capacity, size_t* out_len) {
  const size_t frame_len = kAkHeaderLen + payload_len + kAkCrcLen;
  if (frame_len > out_capacity) return false;

  out[0] = 0x41;  // 'A'
  out[1] = 0x4b;  // 'K'
  out[2] = type;
  out[3] = static_cast<uint8_t>(transfer_id & 0xFF);
  out[4] = static_cast<uint8_t>(transfer_id >> 8);
  out[5] = static_cast<uint8_t>(seq & 0xFF);
  out[6] = static_cast<uint8_t>(seq >> 8);
  out[7] = payload_len;
  if (payload != nullptr && payload_len > 0) {
    std::memcpy(out + kAkHeaderLen, payload, payload_len);
  }
  // CRC covers bytes[2..kAkHeaderLen+payload_len-1] — everything after magic.
  const uint32_t crc = AkCrc32(out + 2, (kAkHeaderLen - 2) + payload_len);
  const size_t crc_offset = kAkHeaderLen + payload_len;
  out[crc_offset + 0] = static_cast<uint8_t>(crc & 0xFF);
  out[crc_offset + 1] = static_cast<uint8_t>((crc >> 8) & 0xFF);
  out[crc_offset + 2] = static_cast<uint8_t>((crc >> 16) & 0xFF);
  out[crc_offset + 3] = static_cast<uint8_t>((crc >> 24) & 0xFF);
  *out_len = frame_len;
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

void TransportMux::Begin() {
#if defined(ESP32)
  if (tx_queue_ != nullptr) return;
  tx_queue_ = static_cast<void*>(xQueueCreate(32, sizeof(TxFrame)));
  if (tx_queue_ == nullptr) {
    Serial.println("fatal:tx_queue_create_failed");
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

void TransportMux::EmitControl(const char* payload) {
  if (payload == nullptr) return;
  const size_t text_len = std::strlen(payload);
  if (text_len == 0 || text_len > kAkMaxPayload) return;
  TxFrame frame{};
  if (!EncodeFrame(
          kAkFrameTypeControl, 0, 0,
          reinterpret_cast<const uint8_t*>(payload),
          static_cast<uint8_t>(text_len),
          frame.binary, sizeof(frame.binary), &frame.binary_len)) {
    return;
  }
  EnqueueFrame(frame);
}

void TransportMux::EmitLog(const String& message) {
  if (message.length() == 0) return;
  const auto text_len = static_cast<uint8_t>(
      message.length() < kAkMaxPayload ? message.length() : kAkMaxPayload);
  TxFrame frame{};
  if (!EncodeFrame(
          kAkFrameTypeLog, 0, 0,
          reinterpret_cast<const uint8_t*>(message.c_str()),
          text_len,
          frame.binary, sizeof(frame.binary), &frame.binary_len)) {
    return;
  }
  EnqueueFrame(frame);
}

void TransportMux::EmitState(const DeviceState& state) {
  if (state.busy) {
    EmitControl("{\"type\":\"state\",\"busy\":true}");
  } else {
    EmitControl("{\"type\":\"state\",\"busy\":false}");
  }
}

void TransportMux::ForwardFrameToBle(const AkFrame& frame) {
  if (tx_char_ == nullptr) {
    EmitLog("{\"evt\":\"ble.forward.skip\",\"reason\":\"no_characteristic\"}");
    return;
  }
  if (frame.raw_len > kMaxBleNotifyBytes) {
    // Frame too large for BLE notify. Send a NACK back to UART so the
    // sender knows this chunk was not delivered.
    TxFrame nack{};
    if (EncodeFrame(
            kAkFrameTypeNack, frame.transfer_id, frame.seq,
            nullptr, 0,
            nack.binary, sizeof(nack.binary), &nack.binary_len)) {
      EnqueueFrame(nack);
    }
    EmitLog("{\"evt\":\"ble.forward.nack\",\"reason\":\"frame_too_large\"}");
    return;
  }
  tx_char_->setValue(frame.raw, frame.raw_len);
  tx_char_->notify();
}

void TransportMux::ForwardFrameToUart(const AkFrame& frame, bool priority) {
  TxFrame tx{};
  tx.priority   = priority;
  tx.binary_len = frame.raw_len;
  std::memcpy(tx.binary, frame.raw, frame.raw_len);
  EnqueueFrame(tx);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

void TransportMux::EnqueueFrame(const TxFrame& frame) {
#if defined(ESP32)
  if (tx_queue_ == nullptr) return;
  const auto queue = reinterpret_cast<QueueHandle_t>(tx_queue_);
  if (frame.priority) {
    xQueueSendToFront(queue, &frame, portMAX_DELAY);
  } else {
    xQueueSend(queue, &frame, portMAX_DELAY);
  }
#else
  EmitFrameDirect(frame);
#endif
}

void TransportMux::EmitFrameDirect(const TxFrame& frame) {
  if (frame.binary_len > 0) {
    Serial.write(frame.binary, frame.binary_len);
    Serial.flush();
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
