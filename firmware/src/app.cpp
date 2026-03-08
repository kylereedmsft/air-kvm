#include "app.hpp"

#include <cstring>
#if defined(ESP32)
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#endif

namespace {
constexpr const char* kDeviceName = "air-kvm-ctrl-cb01";
constexpr const char* kServiceUuid = "6E400101-B5A3-F393-E0A9-E50E24DCCB01";
constexpr const char* kRxCharUuid = "6E400102-B5A3-F393-E0A9-E50E24DCCB01";
constexpr const char* kTxCharUuid = "6E400103-B5A3-F393-E0A9-E50E24DCCB01";

#ifndef AIRKVM_FW_VERSION
#define AIRKVM_FW_VERSION "dev"
#endif
#ifndef AIRKVM_ENABLE_HID
#define AIRKVM_ENABLE_HID 0
#endif
#define AIRKVM_FW_BUILT_AT __DATE__ " " __TIME__

constexpr const char* kBootMsg =
    "{\"type\":\"boot\",\"fw\":\"air-kvm-ctrl-cb01\",\"version\":\"" AIRKVM_FW_VERSION
    "\",\"built_at\":\"" AIRKVM_FW_BUILT_AT "\"}";
constexpr uint8_t kTransferMagic0 = 0x41;  // 'A'
constexpr uint8_t kTransferMagic1 = 0x4b;  // 'K'
constexpr size_t kTransferMinFrameLen = 18;

bool IsBinaryTransferFrame(const std::string& value) {
  if (value.size() < kTransferMinFrameLen) return false;
  const auto* bytes = reinterpret_cast<const uint8_t*>(value.data());
  if (bytes[0] != kTransferMagic0 || bytes[1] != kTransferMagic1) return false;
  const uint16_t payload_len = static_cast<uint16_t>(bytes[12]) |
                               (static_cast<uint16_t>(bytes[13]) << 8);
  const size_t expected_len = kTransferMinFrameLen + payload_len;
  return value.size() == expected_len;
}
}  // namespace

namespace airkvm::fw {

AirKvmApp& AirKvmApp::Instance() {
  static AirKvmApp app;
  return app;
}

AirKvmApp::AirKvmApp() : router_(transport_, state_, hid_), rx_callbacks_(*this) {}

void AirKvmApp::Setup() {
  Serial.begin(115200);
  delay(200);
  transport_.Begin();
#if defined(ESP32)
  if (ble_rx_queue_ == nullptr) {
    ble_rx_queue_ = xQueueCreate(kBleRxQueueDepth, sizeof(BleRxItem));
  }
#endif

  NimBLEDevice::init(kDeviceName);
  NimBLEServer* server = NimBLEDevice::createServer();
  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  if (AIRKVM_ENABLE_HID) {
    hid_.Setup(server, advertising);
  }

  NimBLEService* service = server->createService(kServiceUuid);

  NimBLECharacteristic* rx_char = service->createCharacteristic(
      kRxCharUuid, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  rx_char->setCallbacks(&rx_callbacks_);
  NimBLECharacteristic* tx_char = service->createCharacteristic(
      kTxCharUuid, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  tx_char->setValue(reinterpret_cast<const uint8_t*>(kBootMsg), std::strlen(kBootMsg));
  transport_.SetBleTxCharacteristic(tx_char);

  service->start();
  advertising->addServiceUUID(kServiceUuid);
  advertising->setScanResponse(true);
  advertising->start();

  transport_.EmitControl(kBootMsg);
}

void AirKvmApp::Loop() {
#if defined(ESP32)
  DrainBleRxQueue();
#endif
  const String line = uart_reader_.PollLine();
  if (line.length() == 0) {
    delay(5);
    return;
  }
  router_.ProcessLine(line, "uart");
}

void AirKvmApp::OnBleWrite(const std::string& value) {
  if (value.empty()) return;
#if defined(ESP32)
  if (ble_rx_queue_ != nullptr) {
    BleRxItem item{};
    if (value.size() > kMaxBleWriteLen) {
      return;
    }
    item.len = value.size();
    std::memcpy(item.data, value.data(), item.len);
    xQueueSend(ble_rx_queue_, &item, 0);
    return;
  }
#endif
  ProcessBleWrite(value);
}

void AirKvmApp::ProcessBleWrite(const std::string& value) {
  if (value.empty()) return;
  if (IsBinaryTransferFrame(value)) {
    transport_.EmitBinaryFrame(
        reinterpret_cast<const uint8_t*>(value.data()),
        value.size());
    return;
  }

  bool saw_newline = false;
  for (char c : value) {
    if (c == '\n') {
      saw_newline = true;
      router_.ProcessLine(ble_buffer_, "ble");
      ble_buffer_ = "";
      continue;
    }
    if (c != '\r') {
      ble_buffer_ += c;
    }
  }
  if (!saw_newline && ble_buffer_.length() > 0) {
    router_.ProcessLine(ble_buffer_, "ble");
    ble_buffer_ = "";
  }
}

#if defined(ESP32)
void AirKvmApp::DrainBleRxQueue() {
  if (ble_rx_queue_ == nullptr) return;
  BleRxItem item{};
  while (xQueueReceive(ble_rx_queue_, &item, 0) == pdTRUE) {
    if (item.len == 0 || item.len > kMaxBleWriteLen) continue;
    ProcessBleWrite(std::string(reinterpret_cast<const char*>(item.data), item.len));
  }
}
#endif

AirKvmApp::RxCallbacks::RxCallbacks(AirKvmApp& app) : app_(app) {}

void AirKvmApp::RxCallbacks::onWrite(NimBLECharacteristic* characteristic) {
  app_.OnBleWrite(characteristic->getValue());
}

}  // namespace airkvm::fw
