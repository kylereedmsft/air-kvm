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
  void EmitControlUartOnly(const char* payload);
  void EmitBinaryFrame(const uint8_t* bytes, size_t len);
  void EmitState(const DeviceState& state);

 private:
  static constexpr size_t kMaxUartLineLen = 1024;
  static constexpr size_t kMaxBinaryFrameLen = 1400;
  struct TxFrame {
    bool is_binary;
    char uart_line[kMaxUartLineLen];
    size_t binary_len;
    uint8_t binary[kMaxBinaryFrameLen];
  };

  void EnqueueFrame(const TxFrame& frame);
  void EmitFrameDirect(const TxFrame& frame);
  void EmitBleControl(const char* payload);
#if defined(ESP32)
  static void TxTaskMain(void* arg);
  void TxTaskLoop();
  void* tx_queue_{nullptr};
  void* tx_task_handle_{nullptr};
#endif

  NimBLECharacteristic* tx_char_{nullptr};
};

}  // namespace airkvm::fw
