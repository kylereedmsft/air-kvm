#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>

namespace airkvm::fw {

// AK frame type constants — match shared/binary_frame.js kFrameType
constexpr uint8_t kAkFrameTypeChunk   = 0x01;
constexpr uint8_t kAkFrameTypeControl = 0x02;
constexpr uint8_t kAkFrameTypeLog     = 0x03;
constexpr uint8_t kAkFrameTypeAck     = 0x04;
constexpr uint8_t kAkFrameTypeNack    = 0x05;
constexpr uint8_t kAkFrameTypeReset   = 0x06;

// AK frame layout: magic(2) + type(1) + txid(2) + seq(2) + len(1) + payload(0-255) + crc(4)
constexpr size_t kAkHeaderLen   = 8;
constexpr size_t kAkCrcLen      = 4;
constexpr size_t kAkMaxPayload  = 255;
constexpr size_t kAkMaxFrameLen = kAkHeaderLen + kAkMaxPayload + kAkCrcLen; // 267

// CRC32 (IEEE 802.3) — matches the JS implementation in shared/binary_frame.js
uint32_t AkCrc32(const uint8_t* data, size_t len);

// Parsed, validated AK frame.
struct AkFrame {
  uint8_t  type;
  uint16_t transfer_id;
  uint16_t seq;
  uint8_t  payload[kAkMaxPayload];
  uint8_t  payload_len;
  // Raw bytes — used for zero-copy forwarding without re-encoding.
  uint8_t  raw[kAkMaxFrameLen];
  size_t   raw_len;
};

// Streaming AK frame parser.
//
// Feed bytes from any source; the callback fires synchronously for each complete,
// CRC-verified frame. Garbage bytes are silently dropped. Partial frames are
// buffered internally until enough bytes arrive to complete them.
class AkFrameParser {
 public:
  using FrameCallback = std::function<void(const AkFrame&)>;

  void Feed(const uint8_t* bytes, size_t len, const FrameCallback& on_frame);

  // Discard all buffered state and return to searching for magic bytes.
  void Reset();

 private:
  enum class State { kFindMagic0, kFindMagic1, kReadHeader, kReadPayload, kReadCrc };

  static bool IsValidType(uint8_t type);
  void ProcessByte(uint8_t b, const FrameCallback& on_frame);
  void TryEmitFrame(const FrameCallback& on_frame);

  State   state_{State::kFindMagic0};
  uint8_t header_[kAkHeaderLen]{};
  uint8_t header_pos_{0};
  uint8_t payload_[kAkMaxPayload]{};
  uint8_t payload_pos_{0};
  uint8_t crc_[kAkCrcLen]{};
  uint8_t crc_pos_{0};
};

}  // namespace airkvm::fw
