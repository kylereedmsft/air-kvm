#pragma once

#include <Arduino.h>
#include <cstddef>

#include "device_state.hpp"

class NimBLECharacteristic;

namespace airkvm::fw {

class TransportMux {
 public:
  void Begin();
  void SetBleTxCharacteristic(NimBLECharacteristic* characteristic);
  void EmitLog(const String& message);
  void EmitControl(const char* payload);
  void EmitState(const DeviceState& state);

 private:
  static constexpr size_t kMaxUartLineLen = 1024;
  static constexpr size_t kMaxBlePayloadLen = 768;
  struct TxFrame {
    char uart_line[kMaxUartLineLen];
    size_t ble_len;
    uint8_t ble_payload[kMaxBlePayloadLen];
    bool has_ble;
  };

  void EnqueueFrame(const TxFrame& frame);
  void EmitFrameDirect(const TxFrame& frame);
  static String JsonEscape(const String& in);
#if defined(ESP32)
  static void TxTaskMain(void* arg);
  void TxTaskLoop();
  void* tx_queue_{nullptr};
  void* tx_task_handle_{nullptr};
#endif

  NimBLECharacteristic* tx_char_{nullptr};
};

}  // namespace airkvm::fw
