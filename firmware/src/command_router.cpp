#include "command_router.hpp"

#ifndef AIRKVM_FW_VERSION
#define AIRKVM_FW_VERSION "dev"
#endif
#define AIRKVM_FW_BUILT_AT __DATE__ " " __TIME__

namespace airkvm::fw {

namespace {
bool IsBridgePassthroughType(airkvm::CommandType type) {
  switch (type) {
    case airkvm::CommandType::kDomSnapshotRequest:
    case airkvm::CommandType::kTabsListRequest:
    case airkvm::CommandType::kWindowBoundsRequest:
    case airkvm::CommandType::kTabOpenRequest:
    case airkvm::CommandType::kJsExecRequest:
    case airkvm::CommandType::kScreenshotRequest:
    case airkvm::CommandType::kDomSnapshot:
    case airkvm::CommandType::kTabsList:
    case airkvm::CommandType::kWindowBounds:
    case airkvm::CommandType::kTabOpen:
    case airkvm::CommandType::kTabOpenError:
    case airkvm::CommandType::kJsExecResult:
    case airkvm::CommandType::kJsExecError:
    case airkvm::CommandType::kTabsListError:
    case airkvm::CommandType::kDomSnapshotError:
    case airkvm::CommandType::kWindowBoundsError:
    case airkvm::CommandType::kScreenshotMeta:
    case airkvm::CommandType::kScreenshotChunk:
    case airkvm::CommandType::kScreenshotError:
    case airkvm::CommandType::kStreamAck:
    case airkvm::CommandType::kStreamNack:
    case airkvm::CommandType::kStreamReset:
      return true;
    default:
      return false;
  }
}

const char* ForwardResultCode(TransportMux::BleForwardResult result) {
  switch (result) {
    case TransportMux::BleForwardResult::kSent:
      return "sent";
    case TransportMux::BleForwardResult::kNoCharacteristic:
      return "no_characteristic";
    case TransportMux::BleForwardResult::kNotifyFailed:
      return "notify_failed";
    default:
      return "unknown";
  }
}
}  // namespace

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

  const bool ok = HandleCommand(*cmd, source);
  const bool is_passthrough = IsBridgePassthroughType(cmd->type);
  if (!is_passthrough) {
    if (!ok) {
      transport_.EmitControl("{\"ok\":false,\"error\":\"command_rejected\"}");
    } else {
      transport_.EmitControl("{\"ok\":true}");
    }
  }
}

bool CommandRouter::HandleCommand(const airkvm::Command& cmd, const char* source) {
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
    case airkvm::CommandType::kWindowBoundsRequest:
    case airkvm::CommandType::kTabOpenRequest:
    case airkvm::CommandType::kJsExecRequest:
    case airkvm::CommandType::kScreenshotRequest:
    case airkvm::CommandType::kDomSnapshot:
    case airkvm::CommandType::kTabsList:
    case airkvm::CommandType::kWindowBounds:
    case airkvm::CommandType::kTabOpen:
    case airkvm::CommandType::kTabOpenError:
    case airkvm::CommandType::kJsExecResult:
    case airkvm::CommandType::kJsExecError:
    case airkvm::CommandType::kTabsListError:
    case airkvm::CommandType::kDomSnapshotError:
    case airkvm::CommandType::kWindowBoundsError:
    case airkvm::CommandType::kScreenshotMeta:
    case airkvm::CommandType::kScreenshotChunk:
    case airkvm::CommandType::kScreenshotError:
    case airkvm::CommandType::kStreamAck:
    case airkvm::CommandType::kStreamNack:
    case airkvm::CommandType::kStreamReset: {
      const bool from_ble = source != nullptr && String(source) == "ble";
      if (from_ble) {
        transport_.EmitControlUartOnly(cmd.raw.c_str());
      } else {
        transport_.EmitControlUartOnly(cmd.raw.c_str());
        const auto forwarded = transport_.ForwardControlToBle(cmd.raw.c_str());
        if (forwarded != TransportMux::BleForwardResult::kSent) {
          const String request_id = String(cmd.request_id.c_str());
          const String error =
              String("{\"ok\":false,\"request_id\":\"") + request_id +
              "\",\"error\":\"downstream_not_delivered\",\"detail\":\"" +
              ForwardResultCode(forwarded) + "\"}";
          transport_.EmitControlUartOnly(error.c_str());
          transport_.EmitLog(
              String("{\"evt\":\"bridge.forward.fail\",\"request_id\":\"") + request_id +
              "\",\"detail\":\"" + ForwardResultCode(forwarded) + "\"}");
        }
      }
      return true;
    }
    case airkvm::CommandType::kUnknown:
      return true;
  }
  return true;
}

}  // namespace airkvm::fw
