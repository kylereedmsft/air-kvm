#include "hid_controller.hpp"

#include <NimBLEDevice.h>
#include <NimBLEHIDDevice.h>

#include "transport_mux.hpp"

namespace {
// Delay between consecutive BLE HID notifications (ms).  Must exceed the
// typical BLE connection interval (7.5-30 ms) so the host OS processes each
// press/release as a distinct event and key-repeat does not latch.
constexpr unsigned long kHidReportDelayMs = 8;

// Keyboard report (ID 1) + mouse report (ID 2).
const uint8_t kHidReportMap[] = {
    0x05, 0x01,        // Usage Page (Generic Desktop)
    0x09, 0x06,        // Usage (Keyboard)
    0xA1, 0x01,        // Collection (Application)
    0x85, 0x01,        //   Report ID (1)
    0x05, 0x07,        //   Usage Page (Keyboard/Keypad)
    0x19, 0xE0,        //   Usage Minimum (Keyboard LeftControl)
    0x29, 0xE7,        //   Usage Maximum (Keyboard Right GUI)
    0x15, 0x00,        //   Logical Minimum (0)
    0x25, 0x01,        //   Logical Maximum (1)
    0x75, 0x01,        //   Report Size (1)
    0x95, 0x08,        //   Report Count (8)
    0x81, 0x02,        //   Input (Data,Var,Abs)
    0x95, 0x01,        //   Report Count (1)
    0x75, 0x08,        //   Report Size (8)
    0x81, 0x01,        //   Input (Const,Array,Abs)
    0x95, 0x06,        //   Report Count (6)
    0x75, 0x08,        //   Report Size (8)
    0x15, 0x00,        //   Logical Minimum (0)
    0x25, 0x65,        //   Logical Maximum (101)
    0x05, 0x07,        //   Usage Page (Keyboard/Keypad)
    0x19, 0x00,        //   Usage Minimum (Reserved)
    0x29, 0x65,        //   Usage Maximum (Keyboard Application)
    0x81, 0x00,        //   Input (Data,Array,Abs)
    0xC0,              // End Collection

    0x05, 0x01,        // Usage Page (Generic Desktop)
    0x09, 0x02,        // Usage (Mouse)
    0xA1, 0x01,        // Collection (Application)
    0x85, 0x02,        //   Report ID (2)
    0x09, 0x01,        //   Usage (Pointer)
    0xA1, 0x00,        //   Collection (Physical)
    0x05, 0x09,        //     Usage Page (Buttons)
    0x19, 0x01,        //     Usage Minimum (1)
    0x29, 0x03,        //     Usage Maximum (3)
    0x15, 0x00,        //     Logical Minimum (0)
    0x25, 0x01,        //     Logical Maximum (1)
    0x95, 0x03,        //     Report Count (3)
    0x75, 0x01,        //     Report Size (1)
    0x81, 0x02,        //     Input (Data,Var,Abs)
    0x95, 0x01,        //     Report Count (1)
    0x75, 0x05,        //     Report Size (5)
    0x81, 0x01,        //     Input (Const,Array,Abs)
    0x05, 0x01,        //     Usage Page (Generic Desktop)
    0x09, 0x30,        //     Usage (X)
    0x09, 0x31,        //     Usage (Y)
    0x09, 0x38,        //     Usage (Wheel)
    0x15, 0x81,        //     Logical Minimum (-127)
    0x25, 0x7F,        //     Logical Maximum (127)
    0x75, 0x08,        //     Report Size (8)
    0x95, 0x03,        //     Report Count (3)
    0x81, 0x06,        //     Input (Data,Var,Rel)
    0xC0,              //   End Collection
    0xC0               // End Collection
};

constexpr uint8_t kKeyboardReportId = 1;
constexpr uint8_t kMouseReportId = 2;
constexpr int kMaxMouseMoveSteps = 512;
}  // namespace

namespace airkvm::fw {

void HidController::SetTelemetrySink(TransportMux* transport) {
  telemetry_ = transport;
}

String HidController::HidServiceUuid() const {
  return hid_service_uuid_;
}

void HidController::Setup(NimBLEServer* server, NimBLEAdvertising* advertising) {
  if (server == nullptr) {
    return;
  }

  hid_device_ = new NimBLEHIDDevice(server);
  keyboard_input_ = hid_device_->inputReport(kKeyboardReportId);
  mouse_input_ = hid_device_->inputReport(kMouseReportId);

  hid_device_->manufacturer("air-kvm");
  hid_device_->pnp(0x02, 0x045E, 0x0001, 0x0110);
  hid_device_->hidInfo(0x00, 0x02);
  hid_device_->reportMap((uint8_t*)kHidReportMap, sizeof(kHidReportMap));
  hid_device_->setBatteryLevel(100);
  hid_device_->startServices();
  hid_service_uuid_ = String(hid_device_->hidService()->getUUID().toString().c_str());

  if (advertising != nullptr) {
    advertising->addServiceUUID(hid_device_->hidService()->getUUID());
    advertising->setAppearance(HID_KEYBOARD);
  }
}

bool HidController::SendMouseMoveRel(int dx, int dy) {
  bool step_cap_exceeded = false;
  const bool ok = SendMouseMoveRelChunked(dx, dy, &step_cap_exceeded);
  EmitInjectTelemetry(
      "mouse.move_rel",
      ok,
      ok ? nullptr : (step_cap_exceeded ? "step_cap_exceeded" : "notify_failed"));
  return ok;
}

bool HidController::SendMouseClick(const String& button) {
  const uint8_t mask = ButtonMask(button);
  if (mask == 0) {
    EmitInjectTelemetry("mouse.click", false, "invalid_button");
    return false;
  }

  const bool ok = NotifyMouse(mask, 0, 0, 0) && NotifyMouse(0, 0, 0, 0);
  EmitInjectTelemetry("mouse.click", ok, ok ? nullptr : "notify_failed");
  return ok;
}

bool HidController::SendKeyTap(const String& key) {
  uint8_t modifier = 0;
  uint8_t code = 0;
  if (!ResolveKeyTap(key, &modifier, &code)) {
    EmitInjectTelemetry("key.tap", false, "invalid_key");
    return false;
  }

  if (!NotifyKeyboard(modifier, code)) {
    EmitInjectTelemetry("key.tap", false, "notify_failed");
    return false;
  }
  delay(kHidReportDelayMs);
  const bool released = NotifyKeyboard(0, 0);
  if (!released) {
    EmitInjectTelemetry("key.tap", false, "notify_failed");
    return false;
  }
  EmitInjectTelemetry("key.tap", true, nullptr);
  return true;
}

bool HidController::SendKeyType(const String& text) {
  // Bound command runtime and BLE notification burst size.
  if (text.length() == 0 || text.length() > 128) {
    EmitInjectTelemetry("key.type", false, "invalid_text_length");
    return false;
  }

  for (size_t i = 0; i < text.length(); i += 1) {
    uint8_t modifier = 0;
    uint8_t keycode = 0;
    const String key = String(text.charAt(static_cast<unsigned int>(i)));
    if (!ResolveKeyTap(key, &modifier, &keycode)) {
      EmitInjectTelemetry("key.type", false, "invalid_char");
      return false;
    }
    if (!NotifyKeyboard(modifier, keycode)) {
      EmitInjectTelemetry("key.type", false, "notify_failed");
      return false;
    }
    delay(kHidReportDelayMs);
    if (!NotifyKeyboard(0, 0)) {
      EmitInjectTelemetry("key.type", false, "notify_failed");
      return false;
    }
    delay(kHidReportDelayMs);
  }

  EmitInjectTelemetry("key.type", true, nullptr);
  return true;
}

int8_t HidController::ClampAxis(int value) {
  if (value > 127) {
    return 127;
  }
  if (value < -127) {
    return -127;
  }
  return static_cast<int8_t>(value);
}

uint8_t HidController::ButtonMask(const String& button) {
  if (button == "left") {
    return 0x01;
  }
  if (button == "right") {
    return 0x02;
  }
  if (button == "middle") {
    return 0x04;
  }
  return 0;
}

bool HidController::ResolveKeyTap(const String& key, uint8_t* modifier, uint8_t* keycode) {
  if (modifier == nullptr || keycode == nullptr) return false;
  *modifier = 0;
  *keycode = 0;

  if (key == "Shift" || key == "ShiftLeft") {
    *modifier = 0x02;
    return true;
  }
  if (key == "ShiftRight") {
    *modifier = 0x20;
    return true;
  }
  if (key == "Control" || key == "Ctrl" || key == "ControlLeft") {
    *modifier = 0x01;
    return true;
  }
  if (key == "ControlRight") {
    *modifier = 0x10;
    return true;
  }
  if (key == "Alt" || key == "AltLeft" || key == "Option") {
    *modifier = 0x04;
    return true;
  }
  if (key == "AltRight" || key == "OptionRight") {
    *modifier = 0x40;
    return true;
  }
  if (key == "Meta" || key == "Command" || key == "MetaLeft" || key == "CommandLeft") {
    *modifier = 0x08;
    return true;
  }
  if (key == "MetaRight" || key == "CommandRight") {
    *modifier = 0x80;
    return true;
  }

  if (key == "Enter") {
    *keycode = 0x28;
    return true;
  }
  if (key == "Tab") {
    *keycode = 0x2B;
    return true;
  }
  if (key == "Escape") {
    *keycode = 0x29;
    return true;
  }
  if (key == "Space") {
    *keycode = 0x2C;
    return true;
  }
  if (key.length() == 1) {
    const char c = key[0];
    if (c >= 'a' && c <= 'z') {
      *keycode = static_cast<uint8_t>(0x04 + (c - 'a'));
      return true;
    }
    if (c >= 'A' && c <= 'Z') {
      *keycode = static_cast<uint8_t>(0x04 + (c - 'A'));
      *modifier = 0x02;
      return true;
    }
    if (c >= '1' && c <= '9') {
      *keycode = static_cast<uint8_t>(0x1E + (c - '1'));
      return true;
    }
    if (c == '0') {
      *keycode = 0x27;
      return true;
    }
    if (c == ' ') {
      *keycode = 0x2C;
      return true;
    }
  }
  return false;
}

bool HidController::NotifyKeyboard(uint8_t modifier, uint8_t keycode) {
  if (keyboard_input_ == nullptr) {
    return false;
  }

  uint8_t report[8] = {modifier, 0, keycode, 0, 0, 0, 0, 0};
  keyboard_input_->setValue(report, sizeof(report));
  keyboard_input_->notify();
  return true;
}

bool HidController::NotifyMouse(uint8_t buttons, int dx, int dy, int wheel) {
  if (mouse_input_ == nullptr) {
    return false;
  }

  uint8_t report[4] = {
      buttons,
      static_cast<uint8_t>(ClampAxis(dx)),
      static_cast<uint8_t>(ClampAxis(dy)),
      static_cast<uint8_t>(ClampAxis(wheel)),
  };
  mouse_input_->setValue(report, sizeof(report));
  mouse_input_->notify();
  return true;
}

bool HidController::SendMouseMoveRelChunked(int dx, int dy, bool* step_cap_exceeded) {
  if (step_cap_exceeded != nullptr) {
    *step_cap_exceeded = false;
  }
  int remaining_x = dx;
  int remaining_y = dy;
  int steps = 0;

  // HID mouse axes are 8-bit signed; split long moves into bounded steps.
  while (remaining_x != 0 || remaining_y != 0) {
    steps += 1;
    if (steps > kMaxMouseMoveSteps) {
      if (step_cap_exceeded != nullptr) {
        *step_cap_exceeded = true;
      }
      return false;
    }

    int step_x = remaining_x;
    int step_y = remaining_y;
    if (step_x > 127) step_x = 127;
    if (step_x < -127) step_x = -127;
    if (step_y > 127) step_y = 127;
    if (step_y < -127) step_y = -127;

    if (!NotifyMouse(0, step_x, step_y, 0)) {
      return false;
    }

    remaining_x -= step_x;
    remaining_y -= step_y;
  }
  return true;
}

void HidController::EmitInjectTelemetry(const char* cmd_type, bool result, const char* reject_reason) {
  if (telemetry_ == nullptr) return;
  String payload = "{\"evt\":\"hid.inject\",\"cmd_type\":\"";
  payload += cmd_type != nullptr ? cmd_type : "unknown";
  payload += "\",\"result\":\"";
  payload += result ? "ok" : "reject";
  payload += "\"";
  if (!result && reject_reason != nullptr) {
    payload += ",\"reject_reason\":\"";
    payload += reject_reason;
    payload += "\"";
  }
  payload += "}";
  telemetry_->EmitLog(payload);
}

}  // namespace airkvm::fw
