#include "command_router.hpp"

#ifndef AIRKVM_FW_VERSION
#define AIRKVM_FW_VERSION "dev"
#endif
#define AIRKVM_FW_BUILT_AT __DATE__ " " __TIME__

namespace airkvm::fw {

CommandRouter::CommandRouter(TransportMux& transport, DeviceState& state, HidController& hid)
    : transport_(transport), state_(state), hid_(hid) {}

void CommandRouter::ProcessControlFrame(const AkFrame& frame) {
  const std::string json(
      reinterpret_cast<const char*>(frame.payload),
      frame.payload_len);
  const auto cmd = airkvm::ParseCommandLine(json);
  if (!cmd.has_value()) {
    transport_.EmitControl("{\"ok\":false,\"error\":\"invalid_command\"}");
    return;
  }
  const bool ok = HandleCommand(*cmd);
  transport_.EmitControl(ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"command_rejected\"}");
}

bool CommandRouter::HandleCommand(const airkvm::Command& cmd) {
  switch (cmd.type) {
    case airkvm::CommandType::kMouseMoveRel: {
      const bool ok = hid_.SendMouseMoveRel(cmd.dx, cmd.dy);
      if (!ok) transport_.EmitLog("hid.reject mouse.move_rel");
      return ok;
    }
    case airkvm::CommandType::kMouseMoveAbs:
      return true;
    case airkvm::CommandType::kMouseClick: {
      const bool ok = hid_.SendMouseClick(cmd.button.c_str());
      if (!ok) transport_.EmitLog("hid.reject mouse.click");
      return ok;
    }
    case airkvm::CommandType::kKeyTap: {
      const bool ok = hid_.SendKeyTap(cmd.key.c_str());
      if (!ok) transport_.EmitLog("hid.reject key.tap");
      return ok;
    }
    case airkvm::CommandType::kKeyType: {
      const bool ok = hid_.SendKeyType(cmd.text.c_str());
      if (!ok) transport_.EmitLog("hid.reject key.type");
      return ok;
    }
    case airkvm::CommandType::kStateRequest:
      transport_.EmitState(state_);
      return true;
    case airkvm::CommandType::kStateSet:
      state_.busy = cmd.busy;
      transport_.EmitState(state_);
      return true;
    case airkvm::CommandType::kFwVersionRequest:
      transport_.EmitControl(
          "{\"type\":\"fw.version\",\"version\":\"" AIRKVM_FW_VERSION
          "\",\"built_at\":\"" AIRKVM_FW_BUILT_AT "\"}");
      return true;
    case airkvm::CommandType::kUnknown:
      return true;
  }
  return true;
}

}  // namespace airkvm::fw
