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

  // Handle a CONTROL frame targeting firmware (state, version, etc.).
  void ProcessFwFrame(const AkFrame& frame);

  // Handle a CONTROL frame targeting the HID subsystem (mouse, keyboard).
  void ProcessHidFrame(const AkFrame& frame);

 private:
  bool HandleFwCommand(const airkvm::Command& cmd);
  bool HandleHidCommand(const airkvm::Command& cmd);

  TransportMux& transport_;
  DeviceState& state_;
  HidController& hid_;
};

}  // namespace airkvm::fw
