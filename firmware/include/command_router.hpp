#pragma once

#include <Arduino.h>

#include "device_state.hpp"
#include "hid_controller.hpp"
#include "protocol.hpp"
#include "transport_mux.hpp"

namespace airkvm::fw {

class CommandRouter {
 public:
  CommandRouter(TransportMux& transport, DeviceState& state, HidController& hid);

 void ProcessLine(const String& line, const char* source);

 private:
  bool HandleCommand(const airkvm::Command& cmd);

  TransportMux& transport_;
  DeviceState& state_;
  HidController& hid_;
};

}  // namespace airkvm::fw
