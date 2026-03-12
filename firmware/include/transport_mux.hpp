#pragma once

#include <Arduino.h>
#include <cstddef>

#include "ak_frame_parser.hpp"
#include "device_state.hpp"

class NimBLECharacteristic;

namespace airkvm::fw {

class TransportMux {
 public:
  void Begin();
  void SetBleTxCharacteristic(NimBLECharacteristic* characteristic);

  // Emit a firmware-generated CONTROL frame to UART.
  void EmitControl(const char* payload);

  // Emit a firmware-generated LOG frame to UART.
  void EmitLog(const String& message);

  // Emit a state CONTROL frame to UART.
  void EmitState(const DeviceState& state);

  // Emit a firmware-generated CONTROL frame directly to BLE (bypasses UART queue).
  // Safe to call from the NimBLE subscription callback after the client subscribes.
  void EmitControlToBle(const char* payload);
  // to notify; the caller is responsible for sending a NACK.
  bool ForwardFrameToBle(const AkFrame& frame);

  // Forward an AK frame to UART. priority=true uses xQueueSendToFront
  // so RESET frames jump ahead of any queued data.
  void ForwardFrameToUart(const AkFrame& frame, bool priority = false);

  // Send pre-encoded bytes to UART.
  void SendToUart(const uint8_t* bytes, size_t len, bool priority = false);

 private:
  static constexpr size_t kMaxBinaryFrameLen = kAkMaxFrameLen;  // 267 bytes
  static constexpr size_t kMaxBleNotifyBytes = 512;

  struct TxFrame {
    bool   priority{false};
    size_t binary_len{0};
    uint8_t binary[kMaxBinaryFrameLen]{};
  };

  void EnqueueFrame(const TxFrame& frame);
  void EmitFrameDirect(const TxFrame& frame);

#if defined(ESP32)
  static void TxTaskMain(void* arg);
  void TxTaskLoop();
  void* tx_queue_{nullptr};
  void* tx_task_handle_{nullptr};
#endif

  NimBLECharacteristic* tx_char_{nullptr};
};

}  // namespace airkvm::fw

