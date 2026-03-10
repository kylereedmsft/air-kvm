#include "hid_controller.hpp"

#include <cstdlib>

#include <NimBLEDevice.h>
#include <NimBLEHIDDevice.h>

#include "transport_mux.hpp"

namespace {
// Delay between consecutive BLE HID notifications (ms).  Must exceed the
// typical BLE connection interval (7.5-30 ms) so the host OS processes each
// press/release as a distinct event and key-repeat does not latch.
constexpr unsigned long kHidReportDelayMs = 12;

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
    0x25, 0xE7,        //   Logical Maximum (231)
    0x05, 0x07,        //   Usage Page (Keyboard/Keypad)
    0x19, 0x00,        //   Usage Minimum (Reserved)
    0x29, 0xE7,        //   Usage Maximum (Keyboard Right GUI)
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

struct KeyAlias {
  const char* name;
  uint8_t modifier;
  uint8_t keycode;
};

constexpr KeyAlias kNamedKeyAliases[] = {
    // Modifiers
    {"Shift", 0x02, 0x00},
    {"ShiftLeft", 0x02, 0x00},
    {"ShiftRight", 0x20, 0x00},
    {"Control", 0x01, 0x00},
    {"Ctrl", 0x01, 0x00},
    {"ControlLeft", 0x01, 0x00},
    {"ControlRight", 0x10, 0x00},
    {"Alt", 0x04, 0x00},
    {"AltLeft", 0x04, 0x00},
    {"Option", 0x04, 0x00},
    {"OptionLeft", 0x04, 0x00},
    {"AltRight", 0x40, 0x00},
    {"OptionRight", 0x40, 0x00},
    {"Meta", 0x08, 0x00},
    {"Command", 0x08, 0x00},
    {"MetaLeft", 0x08, 0x00},
    {"CommandLeft", 0x08, 0x00},
    {"MetaRight", 0x80, 0x00},
    {"CommandRight", 0x80, 0x00},

    // Editing/navigation keys.
    {"Enter", 0x00, 0x28},
    {"Return", 0x00, 0x28},
    {"NumpadEnter", 0x00, 0x58},
    {"Tab", 0x00, 0x2B},
    {"Escape", 0x00, 0x29},
    {"Esc", 0x00, 0x29},
    {"Backspace", 0x00, 0x2A},
    {"Delete", 0x00, 0x4C},
    {"Del", 0x00, 0x4C},
    {"Insert", 0x00, 0x49},
    {"Home", 0x00, 0x4A},
    {"End", 0x00, 0x4D},
    {"PageUp", 0x00, 0x4B},
    {"PageDown", 0x00, 0x4E},
    {"ArrowRight", 0x00, 0x4F},
    {"ArrowLeft", 0x00, 0x50},
    {"ArrowDown", 0x00, 0x51},
    {"ArrowUp", 0x00, 0x52},
    {"CapsLock", 0x00, 0x39},
    {"NumLock", 0x00, 0x53},
    {"ScrollLock", 0x00, 0x47},
    {"PrintScreen", 0x00, 0x46},
    {"Pause", 0x00, 0x48},
    {"ContextMenu", 0x00, 0x65},
    {"Application", 0x00, 0x65},
    {"Menu", 0x00, 0x76},

    // Web KeyboardEvent.code symbols and punctuation keys.
    {"Backquote", 0x00, 0x35},
    {"Minus", 0x00, 0x2D},
    {"Equal", 0x00, 0x2E},
    {"BracketLeft", 0x00, 0x2F},
    {"BracketRight", 0x00, 0x30},
    {"Backslash", 0x00, 0x31},
    {"IntlBackslash", 0x00, 0x64},
    {"Semicolon", 0x00, 0x33},
    {"Quote", 0x00, 0x34},
    {"Comma", 0x00, 0x36},
    {"Period", 0x00, 0x37},
    {"Slash", 0x00, 0x38},
    {"Space", 0x00, 0x2C},
    {"Spacebar", 0x00, 0x2C},

    // Numpad aliases.
    {"NumpadAdd", 0x00, 0x57},
    {"NumpadSubtract", 0x00, 0x56},
    {"NumpadMultiply", 0x00, 0x55},
    {"NumpadDivide", 0x00, 0x54},
    {"NumpadDecimal", 0x00, 0x63},
    {"NumpadComma", 0x00, 0x85},
    {"NumpadEqual", 0x00, 0x67},
    {"NumpadParenLeft", 0x00, 0xB6},
    {"NumpadParenRight", 0x00, 0xB7},

    // Consumer/system-ish keys present in keyboard page usage table.
    {"Mute", 0x00, 0x7F},
    {"VolumeMute", 0x00, 0x7F},
    {"VolumeUp", 0x00, 0x80},
    {"VolumeDown", 0x00, 0x81},
    {"Help", 0x00, 0x75},
    {"Stop", 0x00, 0x78},
    {"Again", 0x00, 0x79},
    {"Undo", 0x00, 0x7A},
    {"Cut", 0x00, 0x7B},
    {"Copy", 0x00, 0x7C},
    {"Paste", 0x00, 0x7D},
    {"Find", 0x00, 0x7E},
};

bool ResolveAsciiChar(char c, uint8_t* modifier, uint8_t* keycode) {
  if (modifier == nullptr || keycode == nullptr) {
    return false;
  }
  if (c >= 'a' && c <= 'z') {
    *modifier = 0x00;
    *keycode = static_cast<uint8_t>(0x04 + (c - 'a'));
    return true;
  }
  if (c >= 'A' && c <= 'Z') {
    *modifier = 0x02;
    *keycode = static_cast<uint8_t>(0x04 + (c - 'A'));
    return true;
  }
  if (c >= '1' && c <= '9') {
    *modifier = 0x00;
    *keycode = static_cast<uint8_t>(0x1E + (c - '1'));
    return true;
  }
  switch (c) {
    case '0':
      *modifier = 0x00;
      *keycode = 0x27;
      return true;
    case ' ':
      *modifier = 0x00;
      *keycode = 0x2C;
      return true;
    case '\n':
    case '\r':
      *modifier = 0x00;
      *keycode = 0x28;
      return true;
    case '\t':
      *modifier = 0x00;
      *keycode = 0x2B;
      return true;
    case '\b':
      *modifier = 0x00;
      *keycode = 0x2A;
      return true;
    case '-':
      *modifier = 0x00;
      *keycode = 0x2D;
      return true;
    case '_':
      *modifier = 0x02;
      *keycode = 0x2D;
      return true;
    case '=':
      *modifier = 0x00;
      *keycode = 0x2E;
      return true;
    case '+':
      *modifier = 0x02;
      *keycode = 0x2E;
      return true;
    case '[':
      *modifier = 0x00;
      *keycode = 0x2F;
      return true;
    case '{':
      *modifier = 0x02;
      *keycode = 0x2F;
      return true;
    case ']':
      *modifier = 0x00;
      *keycode = 0x30;
      return true;
    case '}':
      *modifier = 0x02;
      *keycode = 0x30;
      return true;
    case '\\':
      *modifier = 0x00;
      *keycode = 0x31;
      return true;
    case '|':
      *modifier = 0x02;
      *keycode = 0x31;
      return true;
    case ';':
      *modifier = 0x00;
      *keycode = 0x33;
      return true;
    case ':':
      *modifier = 0x02;
      *keycode = 0x33;
      return true;
    case '\'':
      *modifier = 0x00;
      *keycode = 0x34;
      return true;
    case '"':
      *modifier = 0x02;
      *keycode = 0x34;
      return true;
    case '`':
      *modifier = 0x00;
      *keycode = 0x35;
      return true;
    case '~':
      *modifier = 0x02;
      *keycode = 0x35;
      return true;
    case ',':
      *modifier = 0x00;
      *keycode = 0x36;
      return true;
    case '<':
      *modifier = 0x02;
      *keycode = 0x36;
      return true;
    case '.':
      *modifier = 0x00;
      *keycode = 0x37;
      return true;
    case '>':
      *modifier = 0x02;
      *keycode = 0x37;
      return true;
    case '/':
      *modifier = 0x00;
      *keycode = 0x38;
      return true;
    case '?':
      *modifier = 0x02;
      *keycode = 0x38;
      return true;
    case '!':
      *modifier = 0x02;
      *keycode = 0x1E;
      return true;
    case '@':
      *modifier = 0x02;
      *keycode = 0x1F;
      return true;
    case '#':
      *modifier = 0x02;
      *keycode = 0x20;
      return true;
    case '$':
      *modifier = 0x02;
      *keycode = 0x21;
      return true;
    case '%':
      *modifier = 0x02;
      *keycode = 0x22;
      return true;
    case '^':
      *modifier = 0x02;
      *keycode = 0x23;
      return true;
    case '&':
      *modifier = 0x02;
      *keycode = 0x24;
      return true;
    case '*':
      *modifier = 0x02;
      *keycode = 0x25;
      return true;
    case '(':
      *modifier = 0x02;
      *keycode = 0x26;
      return true;
    case ')':
      *modifier = 0x02;
      *keycode = 0x27;
      return true;
    default:
      break;
  }
  return false;
}

bool ResolveDynamicCode(const String& key, uint8_t* modifier, uint8_t* keycode) {
  if (modifier == nullptr || keycode == nullptr) {
    return false;
  }
  if (key.length() == 4 && key.startsWith("Key")) {
    const char c = key[3];
    if (c >= 'A' && c <= 'Z') {
      *modifier = 0x00;
      *keycode = static_cast<uint8_t>(0x04 + (c - 'A'));
      return true;
    }
  }
  if (key.length() == 6 && key.startsWith("Digit")) {
    return ResolveAsciiChar(key[5], modifier, keycode);
  }
  if (key.length() == 7 && key.startsWith("Numpad")) {
    const char c = key[6];
    if (c >= '1' && c <= '9') {
      *modifier = 0x00;
      *keycode = static_cast<uint8_t>(0x59 + (c - '1'));
      return true;
    }
    if (c == '0') {
      *modifier = 0x00;
      *keycode = 0x62;
      return true;
    }
  }
  if (key.length() >= 2 && (key[0] == 'F' || key[0] == 'f')) {
    const int fn = key.substring(1).toInt();
    if (fn >= 1 && fn <= 12) {
      *modifier = 0x00;
      *keycode = static_cast<uint8_t>(0x3A + (fn - 1));
      return true;
    }
    if (fn >= 13 && fn <= 24) {
      *modifier = 0x00;
      *keycode = static_cast<uint8_t>(0x68 + (fn - 13));
      return true;
    }
  }
  return false;
}

bool ResolveRawHidUsage(const String& key, uint8_t* modifier, uint8_t* keycode) {
  if (modifier == nullptr || keycode == nullptr) {
    return false;
  }
  if (!key.startsWith("HID:") && !key.startsWith("hid:")) {
    return false;
  }
  const String raw = key.substring(4);
  if (raw.length() == 0) {
    return false;
  }

  char* end = nullptr;
  const int base = raw.startsWith("0x") || raw.startsWith("0X") ? 16 : 10;
  const long parsed = strtol(raw.c_str(), &end, base);
  if (end == raw.c_str() || *end != '\0' || parsed < 0 || parsed > 0xE7) {
    return false;
  }

  const uint8_t usage = static_cast<uint8_t>(parsed);
  if (usage >= 0xE0 && usage <= 0xE7) {
    *modifier = static_cast<uint8_t>(1u << (usage - 0xE0));
    *keycode = 0x00;
    return true;
  }

  *modifier = 0x00;
  *keycode = usage;
  return true;
}
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

  for (const auto& alias : kNamedKeyAliases) {
    if (key == alias.name) {
      *modifier = alias.modifier;
      *keycode = alias.keycode;
      return true;
    }
  }
  if (ResolveRawHidUsage(key, modifier, keycode)) {
    return true;
  }
  if (ResolveDynamicCode(key, modifier, keycode)) {
    return true;
  }
  if (key.length() == 1) {
    return ResolveAsciiChar(key[0], modifier, keycode);
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
