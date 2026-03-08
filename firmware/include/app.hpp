#pragma once

#include <Arduino.h>
#include <NimBLEDevice.h>
#if defined(ESP32)
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#endif

#include "command_router.hpp"
#include "device_state.hpp"
#include "hid_controller.hpp"
#include "transport_mux.hpp"
#include "uart_line_reader.hpp"

namespace airkvm::fw {

class AirKvmApp {
 public:
  static AirKvmApp& Instance();

  void Setup();
  void Loop();

 private:
  static constexpr size_t kMaxBleWriteLen = 512;
#if defined(ESP32)
  static constexpr size_t kBleRxQueueDepth = 32;
  struct BleRxItem {
    size_t len;
    uint8_t data[kMaxBleWriteLen];
  };
#endif

  class RxCallbacks : public NimBLECharacteristicCallbacks {
   public:
    explicit RxCallbacks(AirKvmApp& app);

    void onWrite(NimBLECharacteristic* characteristic) override;

   private:
    AirKvmApp& app_;
  };

  AirKvmApp();

  void OnBleWrite(const std::string& value);
  void ProcessBleWrite(const std::string& value);
#if defined(ESP32)
  void DrainBleRxQueue();
  QueueHandle_t ble_rx_queue_{nullptr};
#endif

  DeviceState state_;
  HidController hid_;
  TransportMux transport_;
  CommandRouter router_;
  UartLineReader uart_reader_;
  String ble_buffer_;
  RxCallbacks rx_callbacks_;
};

}  // namespace airkvm::fw
