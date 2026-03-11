#include "protocol.hpp"

#include <sstream>

namespace airkvm {
namespace {

bool Contains(const std::string& s, const std::string& needle) {
  return s.find(needle) != std::string::npos;
}

int ExtractInt(const std::string& s, const std::string& key, int fallback) {
  const std::string pattern = "\"" + key + "\":";
  const auto pos = s.find(pattern);
  if (pos == std::string::npos) return fallback;
  const auto start = pos + pattern.size();
  size_t end = start;
  while (end < s.size() && (s[end] == '-' || (s[end] >= '0' && s[end] <= '9'))) {
    ++end;
  }
  if (end == start) return fallback;
  return std::stoi(s.substr(start, end - start));
}

std::string ExtractString(const std::string& s, const std::string& key) {
  const std::string pattern = "\"" + key + "\":\"";
  const auto pos = s.find(pattern);
  if (pos == std::string::npos) return "";
  const auto start = pos + pattern.size();
  std::string out;
  out.reserve(32);
  bool escape = false;
  for (size_t i = start; i < s.size(); ++i) {
    const char c = s[i];
    if (escape) {
      switch (c) {
        case '"':
          out.push_back('"');
          break;
        case '\\':
          out.push_back('\\');
          break;
        case '/':
          out.push_back('/');
          break;
        case 'b':
          out.push_back('\b');
          break;
        case 'f':
          out.push_back('\f');
          break;
        case 'n':
          out.push_back('\n');
          break;
        case 'r':
          out.push_back('\r');
          break;
        case 't':
          out.push_back('\t');
          break;
        default:
          // Keep unknown escapes literal for robustness.
          out.push_back(c);
          break;
      }
      escape = false;
      continue;
    }
    if (c == '\\') {
      escape = true;
      continue;
    }
    if (c == '"') {
      return out;
    }
    out.push_back(c);
  }
  return "";
}

bool ExtractBool(const std::string& s, const std::string& key, bool fallback) {
  const std::string pattern = "\"" + key + "\":";
  const auto pos = s.find(pattern);
  if (pos == std::string::npos) return fallback;
  const auto start = pos + pattern.size();
  if (s.compare(start, 4, "true") == 0) return true;
  if (s.compare(start, 5, "false") == 0) return false;
  return fallback;
}

}  // namespace

std::optional<Command> ParseCommandLine(const std::string& line) {
  if (!Contains(line, "\"type\":\"")) return std::nullopt;

  Command cmd;
  if (Contains(line, "\"type\":\"mouse.move_rel\"")) {
    cmd.type = CommandType::kMouseMoveRel;
    cmd.dx = ExtractInt(line, "dx", 0);
    cmd.dy = ExtractInt(line, "dy", 0);
    return cmd;
  }

  if (Contains(line, "\"type\":\"mouse.move_abs\"")) {
    cmd.type = CommandType::kMouseMoveAbs;
    cmd.x = ExtractInt(line, "x", 0);
    cmd.y = ExtractInt(line, "y", 0);
    return cmd;
  }

  if (Contains(line, "\"type\":\"mouse.click\"")) {
    cmd.type = CommandType::kMouseClick;
    cmd.button = ExtractString(line, "button");
    return cmd;
  }

  if (Contains(line, "\"type\":\"key.tap\"")) {
    cmd.type = CommandType::kKeyTap;
    cmd.key = ExtractString(line, "key");
    return cmd;
  }

  if (Contains(line, "\"type\":\"key.type\"")) {
    cmd.type = CommandType::kKeyType;
    cmd.text = ExtractString(line, "text");
    return cmd;
  }

  if (Contains(line, "\"type\":\"state.request\"")) {
    cmd.type = CommandType::kStateRequest;
    return cmd;
  }

  if (Contains(line, "\"type\":\"state.set\"")) {
    cmd.type = CommandType::kStateSet;
    cmd.busy = ExtractBool(line, "busy", false);
    return cmd;
  }

  if (Contains(line, "\"type\":\"fw.version.request\"")) {
    cmd.type = CommandType::kFwVersionRequest;
    return cmd;
  }

  if (Contains(line, "\"type\":\"dom.snapshot.request\"")) {
    cmd.type = CommandType::kDomSnapshotRequest;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"tabs.list.request\"")) {
    cmd.type = CommandType::kTabsListRequest;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"window.bounds.request\"")) {
    cmd.type = CommandType::kWindowBoundsRequest;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"tab.open.request\"")) {
    cmd.type = CommandType::kTabOpenRequest;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"js.exec.request\"")) {
    cmd.type = CommandType::kJsExecRequest;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"screenshot.request\"")) {
    cmd.type = CommandType::kScreenshotRequest;
    cmd.source = ExtractString(line, "source");
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"dom.snapshot\"")) {
    cmd.type = CommandType::kDomSnapshot;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"tabs.list\"")) {
    cmd.type = CommandType::kTabsList;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"window.bounds\"")) {
    cmd.type = CommandType::kWindowBounds;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"tab.open.error\"")) {
    cmd.type = CommandType::kTabOpenError;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"tab.open\"")) {
    cmd.type = CommandType::kTabOpen;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"js.exec.result\"")) {
    cmd.type = CommandType::kJsExecResult;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"js.exec.error\"")) {
    cmd.type = CommandType::kJsExecError;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"tabs.list.error\"")) {
    cmd.type = CommandType::kTabsListError;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"window.bounds.error\"")) {
    cmd.type = CommandType::kWindowBoundsError;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"dom.snapshot.error\"")) {
    cmd.type = CommandType::kDomSnapshotError;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"screenshot.meta\"")) {
    cmd.type = CommandType::kScreenshotMeta;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.source = ExtractString(line, "source");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"screenshot.chunk\"")) {
    cmd.type = CommandType::kScreenshotChunk;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.source = ExtractString(line, "source");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"screenshot.error\"")) {
    cmd.type = CommandType::kScreenshotError;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.source = ExtractString(line, "source");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"stream.ack\"")) {
    cmd.type = CommandType::kStreamAck;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"stream.nack\"")) {
    cmd.type = CommandType::kStreamNack;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  if (Contains(line, "\"type\":\"stream.reset\"")) {
    cmd.type = CommandType::kStreamReset;
    cmd.request_id = ExtractString(line, "request_id");
    cmd.raw = line;
    return cmd;
  }

  return std::nullopt;
}

std::string AckJson(const std::string& id, bool ok, const std::string& error) {
  std::ostringstream oss;
  oss << "{\"id\":\"" << id << "\",\"ok\":" << (ok ? "true" : "false");
  if (!ok) {
    oss << ",\"error\":\"" << error << "\"";
  }
  oss << "}";
  return oss.str();
}

}  // namespace airkvm
