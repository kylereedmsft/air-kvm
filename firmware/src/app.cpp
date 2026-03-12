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
#define AIRKVM_FW_BUILT_AT __DATE__ " " __TIME__

constexpr const char* kBootMsg =
    R"({"type":"boot","fw":"air-kvm-ctrl-cb01","version":")" AIRKVM_FW_VERSION
    R"(","built_at":")" AIRKVM_FW_BUILT_AT R"("})";

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
    : router_(transport_, state_, hid_), tx_callbacks_(*this), rx_callbacks_(*this), server_callbacks_(*this) {
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
  NimBLEDevice::setSecurityAuth(true, false, true);
  NimBLEDevice::setSecurityIOCap(0x03);
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(&server_callbacks_);
  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  String adv_services = "[\"";
  adv_services += kServiceUuid;
  adv_services += "\"";
  hid_.Setup(server, advertising);
  const String hid_uuid = hid_.HidServiceUuid();
  if (hid_uuid.length() > 0) {
    adv_services += ",\"";
    adv_services += hid_uuid;
    adv_services += "\"";
  }
  adv_services += "]";

  NimBLEService* service = server->createService(kServiceUuid);
  NimBLECharacteristic* rx_char = service->createCharacteristic(
      kRxCharUuid, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  rx_char->setCallbacks(&rx_callbacks_);
  NimBLECharacteristic* tx_char = service->createCharacteristic(
      kTxCharUuid, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  tx_char->setCallbacks(&tx_callbacks_);
  transport_.SetBleTxCharacteristic(tx_char);

  service->start();
  advertising->addServiceUUID(kServiceUuid);
  advertising->setScanResponse(true);
  transport_.EmitLog(
      String(R"({"evt":"ble.adv.payload","device_name":")") + kDeviceName +
      R"(","adv_services":)" + adv_services +
      R"(,"scan_rsp_services":[]})");
  advertising->start();
  transport_.EmitLog(
      String(R"({"evt":"ble.adv.start","device_name":")") + kDeviceName + R"("})");

  transport_.EmitControl(kBootMsg);
}

void AirKvmApp::Loop() {
#if defined(ESP32)
  DrainBleRxQueue();
#endif
  if (!DrainUartBytes()) {
    delay(1);
  }
}

bool AirKvmApp::DrainUartBytes() {
  if (Serial.available() <= 0) return false;
  uint8_t buf[64];
  while (Serial.available() > 0) {
    const size_t to_read = static_cast<size_t>(
        min(static_cast<int>(sizeof(buf)), Serial.available()));
    const size_t n = static_cast<size_t>(
        Serial.readBytes(reinterpret_cast<char*>(buf), to_read));
    if (n == 0) break;
    uart_parser_.Feed(buf, n, [this](const AkFrame& frame) { OnUartFrame(frame); });
  }
  return true;
}

void AirKvmApp::OnUartFrame(const AkFrame& frame) {
  if (frame.type == kAkFrameTypeControl) {
    router_.ProcessControlFrame(frame);
    return;
  }
  if (frame.type == kAkFrameTypeReset) {
    uart_parser_.Reset();
    transport_.ForwardFrameToBle(frame);
    return;
  }
  // CHUNK, ACK, NACK, LOG → forward to extension.
  if (!transport_.ForwardFrameToBle(frame)) {
    // Frame too large for BLE. Send a NACK back to MCP.
    uint8_t nack[kAkMaxFrameLen];
    size_t nack_len = 0;
    if (AkEncodeFrame(kAkFrameTypeNack, frame.transfer_id, frame.seq,
                      nullptr, 0, nack, sizeof(nack), &nack_len)) {
      transport_.SendToUart(nack, nack_len);
    }
    transport_.EmitLog(R"({"evt":"ble.forward.nack","reason":"frame_too_large"})");
  }
}

void AirKvmApp::OnBleFrame(const AkFrame& frame) {
  if (frame.type == kAkFrameTypeReset) {
    ble_parser_.Reset();
    transport_.ForwardFrameToUart(frame, /*priority=*/true);
    return;
  }
  // CHUNK, ACK, NACK → forward to MCP.
  // CONTROL and LOG from the extension are not expected; drop silently.
  if (frame.type == kAkFrameTypeChunk ||
      frame.type == kAkFrameTypeAck   ||
      frame.type == kAkFrameTypeNack) {
    transport_.ForwardFrameToUart(frame);
  }
}

void AirKvmApp::OnBleWrite(const std::string& value) {
  if (value.empty()) return;
#if defined(ESP32)
  if (ble_rx_queue_ != nullptr) {
    if (value.size() > kMaxBleWriteLen) return;
    BleRxItem item{};
    item.len = value.size();
    std::memcpy(item.data, value.data(), item.len);
    if (xQueueSend(ble_rx_queue_, &item, pdMS_TO_TICKS(20)) != pdTRUE) {
      transport_.EmitLog(R"({"evt":"ble.rx_queue_overflow","action":"drop"})");
    }
    return;
  }
#endif
  ProcessBleWrite(value);
}

void AirKvmApp::ProcessBleWrite(const std::string& value) {
  if (value.empty()) return;
  ble_parser_.Feed(
      reinterpret_cast<const uint8_t*>(value.data()),
      value.size(),
      [this](const AkFrame& frame) { OnBleFrame(frame); });
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

AirKvmApp::TxCallbacks::TxCallbacks(AirKvmApp& app) : app_(app) {}

void AirKvmApp::TxCallbacks::onSubscribe(NimBLECharacteristic* /*characteristic*/,
                                          ble_gap_conn_desc* /*desc*/,
                                          uint16_t sub_value) {
  // sub_value 1 = notifications enabled; send boot frame so the extension
  // can resolve its handshake without requiring MCP to be running.
  if (sub_value == 1) {
    app_.OnBleSubscribed();
  }
}

void AirKvmApp::OnBleSubscribed() {
  transport_.EmitControlToBle(kBootMsg);
}

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
  active_conn_count_ = server != nullptr
      ? static_cast<uint32_t>(server->getConnectedCount())
      : active_conn_count_ + 1;
  bool adv_ok = false;
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  if (adv != nullptr) adv_ok = adv->start();
  transport_.EmitLog(
      String(R"({"evt":"ble.conn","active_conn_count":)") + String(active_conn_count_) +
      R"(,"adv_restart":)" + JsonBool(adv_ok) + "}");
}

void AirKvmApp::OnBleDisconnected(NimBLEServer* server) {
  active_conn_count_ = server != nullptr
      ? static_cast<uint32_t>(server->getConnectedCount())
      : 0;
  bool adv_ok = false;
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  if (adv != nullptr) adv_ok = adv->start();
  transport_.EmitLog(
      String(R"({"evt":"ble.disc","active_conn_count":)") + String(active_conn_count_) +
      R"(,"adv_restart":)" + JsonBool(adv_ok) + "}");
}

}  // namespace airkvm::fw
