#include "app.hpp"

void setup() {
  airkvm::fw::AirKvmApp::Instance().Setup();
}

void loop() {
  airkvm::fw::AirKvmApp::Instance().Loop();
}
