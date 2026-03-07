#pragma once

#include <Arduino.h>

namespace airkvm::fw {

class UartLineReader {
 public:
  String PollLine();

 private:
  String buffer_;
};

}  // namespace airkvm::fw
