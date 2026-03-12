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

  // Forward an AK frame to BLE. Sends a NACK back to UART if the frame
  // exceeds the maximum BLE notify size.
  void ForwardFrameToBle(const AkFrame& frame);

  // Forward an AK frame to UART. priority=true uses xQueueSendToFront
  // so RESET frames jump ahead of any queued data.
  void ForwardFrameToUart(const AkFrame& frame, bool priority = false);

 private:
  static constexpr size_t kMaxBinaryFrameLen = kAkMaxFrameLen;  // 267 bytes
  static constexpr size_t kMaxBleNotifyBytes = 512;

  struct TxFrame {
    bool   priority{false};
    size_t binary_len{0};
    uint8_t binary[kMaxBinaryFrameLen]{};
  };

  bool EncodeFrame(
      uint8_t type, uint16_t transfer_id, uint16_t seq,
      const uint8_t* payload, uint8_t payload_len,
      uint8_t* out, size_t out_capacity, size_t* out_len);

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

