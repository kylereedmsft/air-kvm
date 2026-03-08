#include "transport_mux.hpp"

#include <cstdio>
#include <cstring>
#include <string>

#include <NimBLEDevice.h>
#if defined(ESP32)
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#endif

namespace {
constexpr const char* kCtrlPrefix = "{\"ch\":\"ctrl\",\"msg\":";
constexpr const char* kCtrlSuffix = "}";
constexpr const char* kLogPrefix = "{\"ch\":\"log\",\"msg\":\"";
constexpr const char* kLogSuffix = "\"}";
}  // namespace

namespace airkvm::fw {

void TransportMux::Begin() {
#if defined(ESP32)
  if (tx_queue_ != nullptr) return;
  tx_queue_ = static_cast<void*>(xQueueCreate(128, sizeof(TxFrame)));
  if (tx_queue_ == nullptr) return;
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
  const String escaped = JsonEscape(message);
  TxFrame frame{};
  std::snprintf(
      frame.uart_line,
      sizeof(frame.uart_line),
      "%s%s%s",
      kLogPrefix,
      escaped.c_str(),
      kLogSuffix);
  frame.has_ble = false;
  frame.ble_len = 0;
  EnqueueFrame(frame);
}

void TransportMux::EmitControl(const char* payload) {
  TxFrame frame{};
  std::snprintf(
      frame.uart_line,
      sizeof(frame.uart_line),
      "%s%s%s",
      kCtrlPrefix,
      payload,
      kCtrlSuffix);

  const size_t payload_len = std::strlen(payload);
  if (payload_len + 1 <= sizeof(frame.ble_payload)) {
    std::memcpy(frame.ble_payload, payload, payload_len);
    frame.ble_payload[payload_len] = '\n';
    frame.ble_len = payload_len + 1;
    frame.has_ble = true;
  } else {
    frame.has_ble = false;
    frame.ble_len = 0;
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

void TransportMux::EnqueueFrame(const TxFrame& frame) {
#if defined(ESP32)
  if (tx_queue_ != nullptr) {
    const auto queue = reinterpret_cast<QueueHandle_t>(tx_queue_);
    const auto sent = xQueueSend(queue, &frame, pdMS_TO_TICKS(200));
    if (sent == pdTRUE) return;
  }
#endif
  EmitFrameDirect(frame);
}

void TransportMux::EmitFrameDirect(const TxFrame& frame) {
  Serial.println(frame.uart_line);
  if (frame.has_ble && tx_char_ != nullptr && frame.ble_len > 0) {
    tx_char_->setValue(frame.ble_payload, frame.ble_len);
    tx_char_->notify();
  }
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
