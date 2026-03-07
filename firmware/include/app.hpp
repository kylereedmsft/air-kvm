#pragma once

#include <Arduino.h>
#include <NimBLEDevice.h>

#include "command_router.hpp"
#include "device_state.hpp"
#include "transport_mux.hpp"
#include "uart_line_reader.hpp"

namespace airkvm::fw {

class AirKvmApp {
 public:
  static AirKvmApp& Instance();

  void Setup();
  void Loop();

 private:
  class RxCallbacks : public NimBLECharacteristicCallbacks {
   public:
    explicit RxCallbacks(AirKvmApp& app);

    void onWrite(NimBLECharacteristic* characteristic) override;

   private:
    AirKvmApp& app_;
  };

  AirKvmApp();

  void OnBleWrite(const std::string& value);

  DeviceState state_;
  TransportMux transport_;
  CommandRouter router_;
  UartLineReader uart_reader_;
  String ble_buffer_;
  RxCallbacks rx_callbacks_;
};

}  // namespace airkvm::fw
