#include "command_router.hpp"

#ifndef AIRKVM_FW_VERSION
#define AIRKVM_FW_VERSION "dev"
#endif
#define AIRKVM_FW_BUILT_AT __DATE__ " " __TIME__

namespace airkvm::fw {

CommandRouter::CommandRouter(Transport& transport, DeviceState& state, HidController& hid)
    : transport_(transport), state_(state), hid_(hid) {}

void CommandRouter::ProcessFwFrame(const AkFrame& frame, Route& route) {
  const std::string json(
      reinterpret_cast<const char*>(frame.payload),
      frame.payload_len);
  const auto cmd = airkvm::ParseCommandLine(json);
  if (!cmd.has_value()) {
    route.Reply(R"({"ok":false,"error":"invalid_command"})");
    return;
  }
  if (!HandleFwCommand(*cmd, route))
    route.Reply(R"({"ok":false,"error":"invalid_command"})");
}

void CommandRouter::ProcessHidFrame(const AkFrame& frame, Route& route) {
  const std::string json(
      reinterpret_cast<const char*>(frame.payload),
      frame.payload_len);
  const auto cmd = airkvm::ParseCommandLine(json);
  if (!cmd.has_value()) {
    route.Reply(R"({"ok":false,"error":"invalid_command"})");
    return;
  }
  const bool ok = HandleHidCommand(*cmd);
  route.Reply(ok ? R"({"ok":true})" : R"({"ok":false,"error":"command_rejected"})");
}

bool CommandRouter::HandleFwCommand(const airkvm::Command& cmd, Route& route) {
  switch (cmd.type) {
    case airkvm::CommandType::StateRequest:
      route.Reply(state_.busy
          ? R"({"type":"state","busy":true})"
          : R"({"type":"state","busy":false})");
      return true;
    case airkvm::CommandType::StateSet:
      state_.busy = cmd.busy;
      route.Reply(state_.busy
          ? R"({"type":"state","busy":true})"
          : R"({"type":"state","busy":false})");
      return true;
    case airkvm::CommandType::FwVersionRequest:
      route.Reply(
          R"({"type":"fw.version","version":")" AIRKVM_FW_VERSION
          R"(","built_at":")" AIRKVM_FW_BUILT_AT R"("})");
      return true;
    default:
      return false;
  }
}

bool CommandRouter::HandleHidCommand(const airkvm::Command& cmd) {
  switch (cmd.type) {
    case airkvm::CommandType::MouseMoveRel: {
      const bool ok = hid_.SendMouseMoveRel(cmd.dx, cmd.dy);
      if (!ok) transport_.EmitLog("hid.reject mouse.move_rel");
      return ok;
    }
    case airkvm::CommandType::MouseClick: {
      const bool ok = hid_.SendMouseClick(cmd.button.c_str());
      if (!ok) transport_.EmitLog("hid.reject mouse.click");
      return ok;
    }
    case airkvm::CommandType::KeyTap: {
      const bool ok = hid_.SendKeyTap(cmd.key.c_str());
      if (!ok) transport_.EmitLog("hid.reject key.tap");
      return ok;
    }
    case airkvm::CommandType::KeyType: {
      const bool ok = hid_.SendKeyType(cmd.text.c_str());
      if (!ok) transport_.EmitLog("hid.reject key.type");
      return ok;
    }
    default:
      return true;
  }
}

}  // namespace airkvm::fw
