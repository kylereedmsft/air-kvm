#pragma once

#include <cstdint>
#include <optional>
#include <string>

namespace airkvm {

enum class CommandType {
  kUnknown,
  kMouseMoveRel,
  kMouseMoveAbs,
  kMouseClick,
  kKeyTap,
  kKeyType,
  kStateRequest,
  kStateSet,
  kFwVersionRequest,
  kDomSnapshotRequest,
  kTabsListRequest,
  kWindowBoundsRequest,
  kTabOpenRequest,
  kJsExecRequest,
  kScreenshotRequest,
  kDomSnapshot,
  kTabsList,
  kWindowBounds,
  kTabOpen,
  kTabOpenError,
  kJsExecResult,
  kJsExecError,
  kTabsListError,
  kDomSnapshotError,
  kWindowBoundsError,
  kScreenshotMeta,
  kScreenshotChunk,
  kScreenshotError,
  kStreamAck,
  kStreamNack,
  kStreamReset,
};

struct Command {
  CommandType type{CommandType::kUnknown};
  int dx{0};
  int dy{0};
  int x{0};
  int y{0};
  bool busy{false};
  std::string button;
  std::string key;
  std::string text;
  std::string source;
  std::string request_id;
  std::string raw;
};

// Parse a constrained JSON-line command without dynamic JSON dependencies.
// This keeps firmware small for POC and is enough for early integration tests.
std::optional<Command> ParseCommandLine(const std::string& line);

std::string AckJson(const std::string& id, bool ok, const std::string& error = "");

}  // namespace airkvm
