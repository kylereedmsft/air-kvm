#pragma once

#include <cstdint>
#include <optional>
#include <string>

namespace airkvm {

// Firmware-local commands only. Browser tool traffic is bridged as opaque AK frames
// and never reaches the command router.
enum class CommandType {
  Unknown,
  MouseMoveRel,
  MouseMoveAbs,
  MouseScroll,
  MouseClick,
  KeyTap,
  KeyType,
  StateRequest,
  StateSet,
  FwVersionRequest,
};

struct Command {
  CommandType type{CommandType::Unknown};
  int dx{0};
  int dy{0};
  int wheel{0};
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
