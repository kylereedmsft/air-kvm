#include <unity.h>

#include "protocol.hpp"

void test_parse_mouse_move_rel() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"mouse.move_rel\",\"dx\":10,\"dy\":-4}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(airkvm::CommandType::kMouseMoveRel), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL(10, cmd->dx);
  TEST_ASSERT_EQUAL(-4, cmd->dy);
}

void test_parse_key_tap() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"key.tap\",\"key\":\"Enter\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(airkvm::CommandType::kKeyTap), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("Enter", cmd->key.c_str());
}

void test_invalid_command() {
  const auto cmd = airkvm::ParseCommandLine("{\"foo\":\"bar\"}");
  TEST_ASSERT_FALSE(cmd.has_value());
}

void test_parse_state_set() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"state.set\",\"busy\":true}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(airkvm::CommandType::kStateSet), static_cast<int>(cmd->type));
  TEST_ASSERT_TRUE(cmd->busy);
}

void test_parse_fw_version_request() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"fw.version.request\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(airkvm::CommandType::kFwVersionRequest), static_cast<int>(cmd->type));
}

void test_parse_dom_snapshot_request() {
  const auto cmd = airkvm::ParseCommandLine(
      "{\"type\":\"dom.snapshot.request\",\"request_id\":\"abc-1\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(airkvm::CommandType::kDomSnapshotRequest), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("abc-1", cmd->request_id.c_str());
}

void test_parse_screenshot_chunk() {
  const auto cmd = airkvm::ParseCommandLine(
      "{\"type\":\"screenshot.chunk\",\"request_id\":\"r1\",\"source\":\"tab\",\"seq\":0,\"data\":\"abcd\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(airkvm::CommandType::kScreenshotChunk), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("r1", cmd->request_id.c_str());
  TEST_ASSERT_EQUAL_STRING("tab", cmd->source.c_str());
}

void test_ack_json_ok() {
  const auto s = airkvm::AckJson("abc", true);
  TEST_ASSERT_EQUAL_STRING("{\"id\":\"abc\",\"ok\":true}", s.c_str());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_parse_mouse_move_rel);
  RUN_TEST(test_parse_key_tap);
  RUN_TEST(test_invalid_command);
  RUN_TEST(test_parse_state_set);
  RUN_TEST(test_parse_fw_version_request);
  RUN_TEST(test_parse_dom_snapshot_request);
  RUN_TEST(test_parse_screenshot_chunk);
  RUN_TEST(test_ack_json_ok);
  return UNITY_END();
}
