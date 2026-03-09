#include "command_router.hpp"

#ifndef AIRKVM_FW_VERSION
#define AIRKVM_FW_VERSION "dev"
#endif
#define AIRKVM_FW_BUILT_AT __DATE__ " " __TIME__

namespace airkvm::fw {

CommandRouter::CommandRouter(TransportMux& transport, DeviceState& state, HidController& hid)
    : transport_(transport), state_(state), hid_(hid) {}

void CommandRouter::ProcessLine(const String& line, const char* source) {
  if (line.length() == 0) {
    return;
  }

  // Avoid echoing BLE ingress payloads onto UART logs; this stream is for host-side
  // control framing and diagnostics, and BLE command mirroring adds noise/interleaving risk.
  if (source != nullptr && String(source) != "ble") {
    transport_.EmitLog(String("rx.") + source + " " + line);
  }
  const auto cmd = airkvm::ParseCommandLine(line.c_str());
  if (!cmd.has_value()) {
    transport_.EmitControl("{\"ok\":false,\"error\":\"invalid_command\"}");
    return;
  }

  const bool ok = HandleCommand(*cmd);
  if (!ok) {
    transport_.EmitControl("{\"ok\":false,\"error\":\"command_rejected\"}");
  } else {
    transport_.EmitControl("{\"ok\":true}");
  }
}

bool CommandRouter::HandleCommand(const airkvm::Command& cmd) {
  switch (cmd.type) {
    case airkvm::CommandType::kMouseMoveRel: {
      const bool injected = hid_.SendMouseMoveRel(cmd.dx, cmd.dy);
      if (!injected) {
        transport_.EmitLog("hid.reject mouse.move_rel");
      }
      transport_.EmitControl("{\"type\":\"event\",\"event\":\"mouse.move_rel\"}");
      return injected;
    }
    case airkvm::CommandType::kMouseMoveAbs:
      transport_.EmitLog("hid.unsupported mouse.move_abs");
      transport_.EmitControl("{\"type\":\"event\",\"event\":\"mouse.move_abs\"}");
      return true;
    case airkvm::CommandType::kMouseClick: {
      const bool injected = hid_.SendMouseClick(cmd.button.c_str());
      if (!injected) {
        transport_.EmitLog("hid.reject mouse.click");
      }
      transport_.EmitControl("{\"type\":\"event\",\"event\":\"mouse.click\"}");
      return injected;
    }
    case airkvm::CommandType::kKeyTap: {
      const bool injected = hid_.SendKeyTap(cmd.key.c_str());
      if (!injected) {
        transport_.EmitLog("hid.reject key.tap");
      }
      transport_.EmitControl("{\"type\":\"event\",\"event\":\"key.tap\"}");
      return injected;
    }
    case airkvm::CommandType::kKeyType: {
      const bool injected = hid_.SendKeyType(cmd.text.c_str());
      if (!injected) {
        transport_.EmitLog("hid.reject key.type");
      }
      transport_.EmitControl("{\"type\":\"event\",\"event\":\"key.type\"}");
      return injected;
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
    case airkvm::CommandType::kDomSnapshotRequest:
    case airkvm::CommandType::kTabsListRequest:
    case airkvm::CommandType::kTabOpenRequest:
    case airkvm::CommandType::kJsExecRequest:
    case airkvm::CommandType::kScreenshotRequest:
    case airkvm::CommandType::kDomSnapshot:
    case airkvm::CommandType::kTabsList:
    case airkvm::CommandType::kTabOpen:
    case airkvm::CommandType::kTabOpenError:
    case airkvm::CommandType::kJsExecResult:
    case airkvm::CommandType::kJsExecError:
    case airkvm::CommandType::kTabsListError:
    case airkvm::CommandType::kDomSnapshotError:
    case airkvm::CommandType::kScreenshotMeta:
    case airkvm::CommandType::kScreenshotChunk:
    case airkvm::CommandType::kScreenshotError:
    case airkvm::CommandType::kTransferMeta:
    case airkvm::CommandType::kTransferChunk:
    case airkvm::CommandType::kTransferDone:
    case airkvm::CommandType::kTransferDoneAck:
    case airkvm::CommandType::kTransferAck:
    case airkvm::CommandType::kTransferNack:
    case airkvm::CommandType::kTransferResume:
    case airkvm::CommandType::kTransferCancel:
    case airkvm::CommandType::kTransferCancelOk:
    case airkvm::CommandType::kTransferReset:
    case airkvm::CommandType::kTransferResetOk:
    case airkvm::CommandType::kTransferError:
      transport_.EmitControl(cmd.raw.c_str());
      return true;
    case airkvm::CommandType::kUnknown:
      return true;
  }
  return true;
}

}  // namespace airkvm::fw
