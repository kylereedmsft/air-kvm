#include "transport_mux.hpp"

#include <cstring>

#include <NimBLEDevice.h>

namespace {
constexpr const char* kCtrlPrefix = "{\"ch\":\"ctrl\",\"msg\":";
constexpr const char* kCtrlSuffix = "}";
constexpr const char* kLogPrefix = "{\"ch\":\"log\",\"msg\":\"";
constexpr const char* kLogSuffix = "\"}";
}  // namespace

namespace airkvm::fw {

void TransportMux::SetBleTxCharacteristic(NimBLECharacteristic* characteristic) {
  tx_char_ = characteristic;
}

void TransportMux::EmitLog(const String& message) {
  Serial.print(kLogPrefix);
  Serial.print(JsonEscape(message));
  Serial.println(kLogSuffix);
}

void TransportMux::EmitControl(const char* payload) {
  Serial.print(kCtrlPrefix);
  Serial.print(payload);
  Serial.println(kCtrlSuffix);
  if (tx_char_ != nullptr) {
    tx_char_->setValue(reinterpret_cast<const uint8_t*>(payload), std::strlen(payload));
    tx_char_->notify();
  }
}

void TransportMux::EmitState(const DeviceState& state) {
  if (state.busy) {
    EmitControl("{\"type\":\"state\",\"busy\":true}");
  } else {
    EmitControl("{\"type\":\"state\",\"busy\":false}");
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

}  // namespace airkvm::fw
