#pragma once

#include <Arduino.h>

#include "ak_frame_parser.hpp"
#include "device_state.hpp"
#include "hid_controller.hpp"
#include "protocol.hpp"
#include "transport_mux.hpp"

namespace airkvm::fw {

class CommandRouter {
 public:
  CommandRouter(TransportMux& transport, DeviceState& state, HidController& hid);

  // Handle a CONTROL frame from UART. Parses the JSON payload and dispatches
  // to the appropriate firmware-local command handler.
  void ProcessControlFrame(const AkFrame& frame);

 private:
  bool HandleCommand(const airkvm::Command& cmd);

  TransportMux& transport_;
  DeviceState& state_;
  HidController& hid_;
};

}  // namespace airkvm::fw
