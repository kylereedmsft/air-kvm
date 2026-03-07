#include "uart_line_reader.hpp"

namespace airkvm::fw {

String UartLineReader::PollLine() {
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n') {
      String line = buffer_;
      buffer_ = "";
      return line;
    }
    if (c != '\r') {
      buffer_ += c;
    }
  }
  return "";
}

}  // namespace airkvm::fw
