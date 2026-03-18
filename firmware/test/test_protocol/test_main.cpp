#include <unity.h>

#include "protocol.hpp"

void test_parse_mouse_move_rel() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"mouse.move_rel\",\"dx\":10,\"dy\":-4}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(airkvm::CommandType::MouseMoveRel), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL(10, cmd->dx);
  TEST_ASSERT_EQUAL(-4, cmd->dy);
}

void test_parse_mouse_move_abs() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"mouse.move_abs\",\"x\":1234,\"y\":5678}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(airkvm::CommandType::MouseMoveAbs), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL(1234, cmd->x);
  TEST_ASSERT_EQUAL(5678, cmd->y);
}

void test_parse_mouse_scroll() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"mouse.scroll\",\"dy\":-120}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(airkvm::CommandType::MouseScroll), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL(-120, cmd->dy);
  TEST_ASSERT_EQUAL(-120, cmd->wheel);
}

void test_parse_key_tap() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"key.tap\",\"key\":\"Enter\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(airkvm::CommandType::KeyTap), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("Enter", cmd->key.c_str());
}

void test_parse_key_type() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"key.type\",\"text\":\"Bluetooth\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(airkvm::CommandType::KeyType), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("Bluetooth", cmd->text.c_str());
}

void test_parse_key_type_escaped_text() {
  const auto cmd = airkvm::ParseCommandLine(
      "{\"type\":\"key.type\",\"text\":\"\\\"\\\\\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(airkvm::CommandType::KeyType), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("\"\\", cmd->text.c_str());
}

void test_invalid_command() {
  const auto cmd = airkvm::ParseCommandLine("{\"foo\":\"bar\"}");
  TEST_ASSERT_FALSE(cmd.has_value());
}

void test_parse_state_set() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"state.set\",\"busy\":true}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(airkvm::CommandType::StateSet), static_cast<int>(cmd->type));
  TEST_ASSERT_TRUE(cmd->busy);
}

void test_parse_fw_version_request() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"fw.version.request\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(airkvm::CommandType::FwVersionRequest), static_cast<int>(cmd->type));
}

void test_ack_json_ok() {
  const auto s = airkvm::AckJson("abc", true);
  TEST_ASSERT_EQUAL_STRING("{\"id\":\"abc\",\"ok\":true}", s.c_str());
}

void test_ack_json_error() {
  const auto s = airkvm::AckJson("xyz", false, "command_rejected");
  TEST_ASSERT_EQUAL_STRING("{\"id\":\"xyz\",\"ok\":false,\"error\":\"command_rejected\"}", s.c_str());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_parse_mouse_move_rel);
  RUN_TEST(test_parse_mouse_move_abs);
  RUN_TEST(test_parse_mouse_scroll);
  RUN_TEST(test_parse_key_tap);
  RUN_TEST(test_parse_key_type);
  RUN_TEST(test_parse_key_type_escaped_text);
  RUN_TEST(test_invalid_command);
  RUN_TEST(test_parse_state_set);
  RUN_TEST(test_parse_fw_version_request);
  RUN_TEST(test_ack_json_ok);
  RUN_TEST(test_ack_json_error);
  return UNITY_END();
}
