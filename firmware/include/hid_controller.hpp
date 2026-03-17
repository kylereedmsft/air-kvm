#pragma once

#include <Arduino.h>

class NimBLEAdvertising;
class NimBLECharacteristic;
class NimBLEHIDDevice;
class NimBLEServer;

namespace airkvm::fw {

class Transport;

class HidController {
 public:
  HidController() = default;

  void Setup(NimBLEServer* server, NimBLEAdvertising* advertising);
  void SetTelemetrySink(Transport* transport);
  String HidServiceUuid() const;

  bool SendMouseMoveRel(int dx, int dy);
  bool SendMouseMoveAbs(int x, int y);
  bool SendMouseClick(const String& button);
  bool SendKeyTap(const String& key);
  bool SendKeyType(const String& text);

 private:
  static int8_t ClampAxis(int value);
  static uint16_t ClampAbsAxis(int value);
  static uint8_t ButtonMask(const String& button);
  static bool ResolveKeyTap(const String& key, uint8_t* modifier, uint8_t* keycode);

  bool NotifyKeyboard(uint8_t modifier, uint8_t keycode);
  bool NotifyMouse(uint8_t buttons, int dx, int dy, int wheel);
  bool NotifyMouseAbs(uint8_t buttons, int x, int y);
  bool SendMouseMoveRelChunked(int dx, int dy, bool* step_cap_exceeded = nullptr);
  void EmitInjectTelemetry(const char* cmd_type, bool result, const char* reject_reason = nullptr);

  NimBLEHIDDevice* hid_device_{nullptr};
  NimBLECharacteristic* keyboard_input_{nullptr};
  NimBLECharacteristic* mouse_input_{nullptr};
  NimBLECharacteristic* mouse_abs_input_{nullptr};
  String hid_service_uuid_{};
  Transport* telemetry_{nullptr};
};

}  // namespace airkvm::fw
