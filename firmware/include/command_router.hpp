#pragma once

#include <Arduino.h>

#include "device_state.hpp"
#include "protocol.hpp"
#include "transport_mux.hpp"

namespace airkvm::fw {

class CommandRouter {
 public:
  CommandRouter(TransportMux& transport, DeviceState& state);

  void ProcessLine(const String& line, const char* source);

 private:
  void HandleCommand(const airkvm::Command& cmd);

  TransportMux& transport_;
  DeviceState& state_;
};

}  // namespace airkvm::fw
