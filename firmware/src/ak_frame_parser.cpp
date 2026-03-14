#include "ak_frame_parser.hpp"

#include <cstring>

namespace airkvm::fw {

namespace {
constexpr uint8_t kMagic0 = 0x41;  // 'A'
constexpr uint8_t kMagic1 = 0x4b;  // 'K'
}  // namespace

uint32_t AkCrc32(const uint8_t* data, size_t len) {
  uint32_t crc = 0xFFFFFFFFu;
  for (size_t i = 0; i < len; ++i) {
    crc ^= data[i];
    for (int j = 0; j < 8; ++j) {
      const uint32_t mask = static_cast<uint32_t>(-(static_cast<int32_t>(crc & 1u)));
      crc = (crc >> 1) ^ (0xEDB88320u & mask);
    }
  }
  return ~crc;
}

bool AkFrameParser::IsValidType(uint8_t type) {
  const uint8_t frame_type = AkDecodeFrameType(type);
  return frame_type >= kAkFrameTypeChunk && frame_type <= kAkFrameTypeReset;
}

bool AkEncodeFrame(
    uint8_t type, uint16_t transfer_id, uint16_t seq,
    const uint8_t* payload, uint8_t payload_len,
    uint8_t* out, size_t out_capacity, size_t* out_len) {
  const size_t frame_len = kAkHeaderLen + payload_len + kAkCrcLen;
  if (frame_len > out_capacity) return false;
  out[0] = kMagic0;
  out[1] = kMagic1;
  out[2] = type;
  out[3] = static_cast<uint8_t>(transfer_id & 0xFF);
  out[4] = static_cast<uint8_t>(transfer_id >> 8);
  out[5] = static_cast<uint8_t>(seq & 0xFF);
  out[6] = static_cast<uint8_t>(seq >> 8);
  out[7] = payload_len;
  if (payload != nullptr && payload_len > 0) {
    std::memcpy(out + kAkHeaderLen, payload, payload_len);
  }
  const uint32_t crc = AkCrc32(out + 2, (kAkHeaderLen - 2) + payload_len);
  const size_t crc_offset = kAkHeaderLen + payload_len;
  out[crc_offset + 0] = static_cast<uint8_t>(crc & 0xFF);
  out[crc_offset + 1] = static_cast<uint8_t>((crc >> 8) & 0xFF);
  out[crc_offset + 2] = static_cast<uint8_t>((crc >> 16) & 0xFF);
  out[crc_offset + 3] = static_cast<uint8_t>((crc >> 24) & 0xFF);
  *out_len = frame_len;
  return true;
}

void AkFrameParser::Reset() {
  state_       = State::FindMagic0;
  header_pos_  = 0;
  payload_pos_ = 0;
  crc_pos_     = 0;
}

void AkFrameParser::Feed(const uint8_t* bytes, size_t len, const FrameCallback& on_frame) {
  for (size_t i = 0; i < len; ++i) {
    ProcessByte(bytes[i], on_frame);
  }
}

void AkFrameParser::ProcessByte(uint8_t b, const FrameCallback& on_frame) {
  switch (state_) {
    case State::FindMagic0:
      if (b == kMagic0) {
        header_[0] = b;
        state_ = State::FindMagic1;
      }
      return;

    case State::FindMagic1:
      if (b == kMagic1) {
        header_[1] = b;
        header_pos_ = 2;
        state_ = State::ReadHeader;
      } else if (b == kMagic0) {
        // The 0x41 could be the start of a new magic sequence.
        header_[0] = b;
      } else {
        state_ = State::FindMagic0;
      }
      return;

    case State::ReadHeader:
      header_[header_pos_++] = b;
      if (header_pos_ == kAkHeaderLen) {
        if (!IsValidType(header_[2])) {
          Reset();
          return;
        }
        payload_pos_ = 0;
        crc_pos_     = 0;
        state_ = header_[7] > 0 ? State::ReadPayload : State::ReadCrc;
      }
      return;

    case State::ReadPayload:
      payload_[payload_pos_++] = b;
      if (payload_pos_ == header_[7]) {
        state_ = State::ReadCrc;
      }
      return;

    case State::ReadCrc:
      crc_[crc_pos_++] = b;
      if (crc_pos_ == kAkCrcLen) {
        TryEmitFrame(on_frame);
        Reset();
      }
      return;
  }
}

void AkFrameParser::TryEmitFrame(const FrameCallback& on_frame) {
  const uint8_t payload_len = header_[7];
  const size_t raw_len = kAkHeaderLen + payload_len + kAkCrcLen;

  // Assemble raw bytes for CRC verification and zero-copy forwarding.
  uint8_t raw[kAkMaxFrameLen];
  std::memcpy(raw, header_, kAkHeaderLen);
  if (payload_len > 0) {
    std::memcpy(raw + kAkHeaderLen, payload_, payload_len);
  }
  std::memcpy(raw + kAkHeaderLen + payload_len, crc_, kAkCrcLen);

  // CRC covers bytes[2..kAkHeaderLen+payload_len-1] — everything after magic.
  const uint32_t want_crc = AkCrc32(raw + 2, (kAkHeaderLen - 2) + payload_len);
  const uint32_t got_crc =
      static_cast<uint32_t>(crc_[0]) |
      (static_cast<uint32_t>(crc_[1]) << 8) |
      (static_cast<uint32_t>(crc_[2]) << 16) |
      (static_cast<uint32_t>(crc_[3]) << 24);
  if (got_crc != want_crc) {
    return;  // Drop silently.
  }

  AkFrame frame{};
  frame.type        = AkDecodeFrameType(header_[2]);
  frame.target      = AkDecodeTarget(header_[2]);
  frame.transfer_id = static_cast<uint16_t>(header_[3]) | (static_cast<uint16_t>(header_[4]) << 8);
  frame.seq         = static_cast<uint16_t>(header_[5]) | (static_cast<uint16_t>(header_[6]) << 8);
  frame.payload_len = payload_len;
  if (payload_len > 0) {
    std::memcpy(frame.payload, payload_, payload_len);
  }
  frame.raw_len = raw_len;
  std::memcpy(frame.raw, raw, raw_len);

  on_frame(frame);
}

}  // namespace airkvm::fw
