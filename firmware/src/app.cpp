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
#ifndef AIRKVM_HID_SECURITY_MODE
#define AIRKVM_HID_SECURITY_MODE 1
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

String JsonBool(bool value) {
  return value ? "true" : "false";
}
}  // namespace

namespace airkvm::fw {

AirKvmApp& AirKvmApp::Instance() {
  static AirKvmApp app;
  return app;
}

AirKvmApp::AirKvmApp()
    : router_(transport_, state_, hid_), rx_callbacks_(*this), server_callbacks_(*this) {
  hid_.SetTelemetrySink(&transport_);
}

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
  if (AIRKVM_ENABLE_HID && AIRKVM_HID_SECURITY_MODE != 0) {
    // Make HID pairing/bonding explicit for host OSes that require secure HID workflows.
    NimBLEDevice::setSecurityAuth(true, false, true);
    NimBLEDevice::setSecurityIOCap(0x03);  // BLE_HS_IO_NO_INPUT_OUTPUT
  }
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(&server_callbacks_);
  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  hid_enabled_ = AIRKVM_ENABLE_HID != 0;
  String adv_services = "[\"";
  adv_services += kServiceUuid;
  adv_services += "\"";
  if (AIRKVM_ENABLE_HID) {
    hid_.Setup(server, advertising);
    const String hid_uuid = hid_.HidServiceUuid();
    if (hid_uuid.length() > 0) {
      adv_services += ",\"";
      adv_services += hid_uuid;
      adv_services += "\"";
    }
  }
  adv_services += "]";

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
  transport_.EmitLog(
      String("{\"evt\":\"ble.adv.payload\",\"hid_enabled\":") + JsonBool(hid_enabled_) +
      ",\"device_name\":\"" + kDeviceName +
      "\",\"adv_services\":" + adv_services +
      ",\"scan_rsp_services\":[]}");
  advertising->start();
  transport_.EmitLog(
      String("{\"evt\":\"ble.adv.start\",\"hid_enabled\":") + JsonBool(hid_enabled_) +
      ",\"device_name\":\"" + kDeviceName + "\"}");

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
    // Keep BLE->UART serialization on the queue path to avoid interleaving writes
    // from callback context with the main loop UART writer.
    if (xQueueSend(ble_rx_queue_, &item, pdMS_TO_TICKS(20)) == pdTRUE) {
      return;
    }
    transport_.EmitLog("{\"evt\":\"ble.rx_queue_overflow\",\"action\":\"drop\"}");
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
    // Generate stream.ack back to BLE sender.
    // Extract transfer_id (bytes 4-7 LE) and seq (bytes 8-11 LE) from the AK frame.
    if (value.size() >= kTransferMinFrameLen) {
      const auto* b = reinterpret_cast<const uint8_t*>(value.data());
      const uint32_t tid = static_cast<uint32_t>(b[4]) |
                           (static_cast<uint32_t>(b[5]) << 8) |
                           (static_cast<uint32_t>(b[6]) << 16) |
                           (static_cast<uint32_t>(b[7]) << 24);
      const uint32_t raw_seq = static_cast<uint32_t>(b[8]) |
                               (static_cast<uint32_t>(b[9]) << 8) |
                               (static_cast<uint32_t>(b[10]) << 16) |
                               (static_cast<uint32_t>(b[11]) << 24);
      const uint32_t seq = raw_seq & 0x7FFFFFFFu;
      char ack[128];
      snprintf(ack, sizeof(ack),
               "{\"type\":\"stream.ack\",\"transfer_id\":\"tx_%08x\",\"seq\":%u}",
               tid, seq);
      transport_.ForwardControlToBle(ack);
    }
    return;
  }

  for (char c : value) {
    if (c == '\n') {
      router_.ProcessLine(ble_buffer_, "ble");
      ble_buffer_ = "";
      continue;
    }
    if (c != '\r') {
      ble_buffer_ += c;
      if (ble_buffer_.length() > kMaxBleControlBufferLen) {
        transport_.EmitLog("{\"evt\":\"ble.ctrl.drop\",\"reason\":\"buffer_overflow\"}");
        ble_buffer_ = "";
      }
    }
  }
  // Keep buffering partial BLE control payloads until a newline-delimited
  // command arrives. This prevents fragmentary JSON from being parsed early.
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

AirKvmApp::ServerCallbacks::ServerCallbacks(AirKvmApp& app) : app_(app) {}

void AirKvmApp::ServerCallbacks::onConnect(NimBLEServer* server) {
  app_.OnBleConnected(server);
}

void AirKvmApp::ServerCallbacks::onDisconnect(NimBLEServer* server) {
  app_.OnBleDisconnected(server);
}

void AirKvmApp::OnBleConnected(NimBLEServer* server) {
  active_conn_count_ = server != nullptr ? static_cast<uint32_t>(server->getConnectedCount()) : active_conn_count_ + 1;
  bool adv_restart_ok = false;
  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  if (advertising != nullptr) {
    adv_restart_ok = advertising->start();
  }
  transport_.EmitLog(
      String("{\"evt\":\"ble.conn\",\"conn_id\":null,\"peer\":null,\"active_conn_count\":") +
      String(active_conn_count_) +
      ",\"adv_restart\":" + JsonBool(adv_restart_ok) +
      ",\"hid_enabled\":" + JsonBool(hid_enabled_) + "}");
}

void AirKvmApp::OnBleDisconnected(NimBLEServer* server) {
  active_conn_count_ = server != nullptr ? static_cast<uint32_t>(server->getConnectedCount()) : 0;
  bool adv_restart_ok = false;
  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  if (advertising != nullptr) {
    adv_restart_ok = advertising->start();
  }
  transport_.EmitLog(
      String("{\"evt\":\"ble.disc\",\"conn_id\":null,\"peer\":null,\"disc_reason\":null,\"active_conn_count\":") +
      String(active_conn_count_) +
      ",\"adv_restart\":" + JsonBool(adv_restart_ok) +
      ",\"hid_enabled\":" + JsonBool(hid_enabled_) + "}");
}

}  // namespace airkvm::fw
