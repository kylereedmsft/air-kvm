#include <unity.h>

#include "ak_frame_parser.hpp"

using namespace airkvm::fw;

// Build a minimal valid AK frame into out[]. Returns total length.
static size_t build_frame(uint8_t* out, uint8_t type, uint16_t txid, uint16_t seq,
                          const uint8_t* payload, uint8_t plen) {
  out[0] = 0x41; // 'A'
  out[1] = 0x4B; // 'K'
  out[2] = type;
  out[3] = static_cast<uint8_t>(txid & 0xFF);
  out[4] = static_cast<uint8_t>(txid >> 8);
  out[5] = static_cast<uint8_t>(seq & 0xFF);
  out[6] = static_cast<uint8_t>(seq >> 8);
  out[7] = plen;
  for (uint8_t i = 0; i < plen; ++i) out[8 + i] = payload[i];
  const uint32_t crc = AkCrc32(out + 2, (kAkHeaderLen - 2) + plen);
  const size_t crc_off = kAkHeaderLen + plen;
  out[crc_off + 0] = static_cast<uint8_t>(crc & 0xFF);
  out[crc_off + 1] = static_cast<uint8_t>((crc >> 8) & 0xFF);
  out[crc_off + 2] = static_cast<uint8_t>((crc >> 16) & 0xFF);
  out[crc_off + 3] = static_cast<uint8_t>((crc >> 24) & 0xFF);
  return kAkHeaderLen + plen + kAkCrcLen;
}

void test_parse_valid_chunk() {
  uint8_t payload[] = {0x01, 0x02, 0x03};
  uint8_t buf[kAkMaxFrameLen];
  const size_t len = build_frame(buf, kAkFrameTypeChunk, 0x0001, 0x0000, payload, sizeof(payload));

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, len, [&](const AkFrame& f) {
    ++count;
    TEST_ASSERT_EQUAL(kAkFrameTypeChunk, f.type);
    TEST_ASSERT_EQUAL(0x0001, f.transfer_id);
    TEST_ASSERT_EQUAL(0x0000, f.seq);
    TEST_ASSERT_EQUAL(3, f.payload_len);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(payload, f.payload, 3);
    TEST_ASSERT_EQUAL(len, f.raw_len);
  });
  TEST_ASSERT_EQUAL(1, count);
}

void test_parse_all_frame_types() {
  const uint8_t types[] = {
    kAkFrameTypeChunk, kAkFrameTypeControl, kAkFrameTypeLog,
    kAkFrameTypeAck,   kAkFrameTypeNack,    kAkFrameTypeReset
  };
  AkFrameParser parser;
  for (uint8_t t : types) {
    uint8_t buf[kAkMaxFrameLen];
    const size_t len = build_frame(buf, t, 0, 0, nullptr, 0);
    int count = 0;
    parser.Feed(buf, len, [&](const AkFrame& f) {
      ++count;
      TEST_ASSERT_EQUAL(t, f.type);
    });
    TEST_ASSERT_EQUAL(1, count);
  }
}

void test_garbage_before_magic_is_dropped() {
  uint8_t payload[] = {0xAA};
  uint8_t frame[kAkMaxFrameLen];
  const size_t frame_len = build_frame(frame, kAkFrameTypeAck, 0, 0, payload, 1);

  uint8_t buf[16 + kAkMaxFrameLen];
  // Prepend 16 garbage bytes
  for (int i = 0; i < 16; ++i) buf[i] = 0xFF;
  memcpy(buf + 16, frame, frame_len);

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, 16 + frame_len, [&](const AkFrame& f) {
    ++count;
    TEST_ASSERT_EQUAL(kAkFrameTypeAck, f.type);
  });
  TEST_ASSERT_EQUAL(1, count);
}

void test_bad_crc_drops_frame() {
  uint8_t buf[kAkMaxFrameLen];
  const size_t len = build_frame(buf, kAkFrameTypeChunk, 0, 0, nullptr, 0);
  // Corrupt the CRC
  buf[len - 1] ^= 0xFF;

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, len, [&](const AkFrame&) { ++count; });
  TEST_ASSERT_EQUAL(0, count);
}

void test_frame_split_across_feeds() {
  uint8_t buf[kAkMaxFrameLen];
  const size_t len = build_frame(buf, kAkFrameTypeNack, 0x0002, 0x0001, nullptr, 0);

  int count = 0;
  AkFrameParser parser;
  // Feed one byte at a time
  for (size_t i = 0; i < len; ++i) {
    parser.Feed(buf + i, 1, [&](const AkFrame& f) {
      ++count;
      TEST_ASSERT_EQUAL(kAkFrameTypeNack, f.type);
    });
  }
  TEST_ASSERT_EQUAL(1, count);
}

void test_multiple_frames_in_one_feed() {
  uint8_t buf[kAkMaxFrameLen * 3];
  size_t off = 0;
  for (int i = 0; i < 3; ++i) {
    const uint8_t p = static_cast<uint8_t>(i);
    off += build_frame(buf + off, kAkFrameTypeChunk, static_cast<uint16_t>(i), 0, &p, 1);
  }

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, off, [&](const AkFrame&) { ++count; });
  TEST_ASSERT_EQUAL(3, count);
}

void test_reset_clears_partial_state() {
  // Send first byte of a frame, then reset, then send a full valid frame.
  uint8_t buf[kAkMaxFrameLen];
  const size_t len = build_frame(buf, kAkFrameTypeLog, 0, 0, nullptr, 0);

  int count = 0;
  AkFrameParser parser;
  // Feed just the magic bytes of a different partial frame
  uint8_t partial[] = {0x41, 0x4B, 0x01};
  parser.Feed(partial, sizeof(partial), [&](const AkFrame&) { ++count; });
  TEST_ASSERT_EQUAL(0, count);

  parser.Reset();
  parser.Feed(buf, len, [&](const AkFrame& f) {
    ++count;
    TEST_ASSERT_EQUAL(kAkFrameTypeLog, f.type);
  });
  TEST_ASSERT_EQUAL(1, count);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_parse_valid_chunk);
  RUN_TEST(test_parse_all_frame_types);
  RUN_TEST(test_garbage_before_magic_is_dropped);
  RUN_TEST(test_bad_crc_drops_frame);
  RUN_TEST(test_frame_split_across_feeds);
  RUN_TEST(test_multiple_frames_in_one_feed);
  RUN_TEST(test_reset_clears_partial_state);
  return UNITY_END();
}
