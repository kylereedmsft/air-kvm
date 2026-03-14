#pragma once

#include <Arduino.h>
#include <NimBLEDevice.h>
#if defined(ESP32)
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#endif

#include "ak_frame_parser.hpp"
#include "command_router.hpp"
#include "device_state.hpp"
#include "hid_controller.hpp"
#include "transport_mux.hpp"

namespace airkvm::fw {

class AirKvmApp {
 public:
  static AirKvmApp& Instance();

  void Setup();
  void Loop();

 private:
  static constexpr size_t kMaxBleWriteLen = 512;
#if defined(ESP32)
  static constexpr size_t kBleRxQueueDepth = 96;
  struct BleRxItem {
    size_t len;
    uint8_t data[kMaxBleWriteLen];
  };
#endif

  class TxCallbacks : public NimBLECharacteristicCallbacks {
   public:
    explicit TxCallbacks(AirKvmApp& app);
    void onSubscribe(NimBLECharacteristic* characteristic,
                     ble_gap_conn_desc* desc,
                     uint16_t sub_value) override;
   private:
    AirKvmApp& app_;
  };

  class RxCallbacks : public NimBLECharacteristicCallbacks {
   public:
    explicit RxCallbacks(AirKvmApp& app);
    void onWrite(NimBLECharacteristic* characteristic) override;
   private:
    AirKvmApp& app_;
  };

  class ServerCallbacks : public NimBLEServerCallbacks {
   public:
    explicit ServerCallbacks(AirKvmApp& app);
    void onConnect(NimBLEServer* server) override;
    void onDisconnect(NimBLEServer* server) override;
   private:
    AirKvmApp& app_;
  };

  AirKvmApp();

  void OnBleWrite(const std::string& value);
  void ProcessBleWrite(const std::string& value);
  void OnBleSubscribed();
  void OnUartFrame(const AkFrame& frame);
  void OnBleFrame(const AkFrame& frame);
  void OnBleConnected(NimBLEServer* server);
  void OnBleDisconnected(NimBLEServer* server);
  void SendNack(const AkFrame& frame);
  bool DrainUartBytes();
#if defined(ESP32)
  void DrainBleRxQueue();
  QueueHandle_t ble_rx_queue_{nullptr};
#endif

  DeviceState     state_;
  HidController   hid_;
  TransportMux    transport_;
  CommandRouter   router_;
  AkFrameParser   uart_parser_;
  AkFrameParser   ble_parser_;
  TxCallbacks     tx_callbacks_;
  RxCallbacks     rx_callbacks_;
  ServerCallbacks server_callbacks_;
  uint32_t        active_conn_count_{0};
};

}  // namespace airkvm::fw
