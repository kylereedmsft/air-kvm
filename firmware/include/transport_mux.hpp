#pragma once

#include <Arduino.h>

#include "device_state.hpp"

class NimBLECharacteristic;

namespace airkvm::fw {

class TransportMux {
 public:
  void SetBleTxCharacteristic(NimBLECharacteristic* characteristic);
  void EmitLog(const String& message);
  void EmitControl(const char* payload);
  void EmitState(const DeviceState& state);

 private:
  static String JsonEscape(const String& in);

  NimBLECharacteristic* tx_char_{nullptr};
};

}  // namespace airkvm::fw
