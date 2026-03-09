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

void test_parse_key_type() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"key.type\",\"text\":\"Bluetooth\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(airkvm::CommandType::kKeyType), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("Bluetooth", cmd->text.c_str());
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

void test_parse_tabs_list_request() {
  const auto cmd = airkvm::ParseCommandLine(
      "{\"type\":\"tabs.list.request\",\"request_id\":\"tabs-1\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(airkvm::CommandType::kTabsListRequest), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("tabs-1", cmd->request_id.c_str());
}

void test_parse_tab_open_request() {
  const auto cmd = airkvm::ParseCommandLine(
      "{\"type\":\"tab.open.request\",\"request_id\":\"open-1\",\"url\":\"https://example.com\",\"active\":true}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(airkvm::CommandType::kTabOpenRequest), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("open-1", cmd->request_id.c_str());
}

void test_parse_tab_open_error() {
  const auto cmd = airkvm::ParseCommandLine(
      "{\"type\":\"tab.open.error\",\"request_id\":\"open-1\",\"error\":\"tabs_create_failed\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(airkvm::CommandType::kTabOpenError), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("open-1", cmd->request_id.c_str());
}

void test_parse_transfer_resume() {
  const auto cmd = airkvm::ParseCommandLine(
      "{\"type\":\"transfer.resume\",\"request_id\":\"shot-1\",\"transfer_id\":\"tx-1\",\"from_seq\":10}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(airkvm::CommandType::kTransferResume), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("shot-1", cmd->request_id.c_str());
}

void test_parse_js_exec_request() {
  const auto cmd = airkvm::ParseCommandLine(
      "{\"type\":\"js.exec.request\",\"request_id\":\"js-1\",\"script\":\"return document.title;\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(airkvm::CommandType::kJsExecRequest), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("js-1", cmd->request_id.c_str());
}

void test_parse_js_exec_result() {
  const auto cmd = airkvm::ParseCommandLine(
      "{\"type\":\"js.exec.result\",\"request_id\":\"js-1\",\"value_json\":\"\\\"ok\\\"\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(airkvm::CommandType::kJsExecResult), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("js-1", cmd->request_id.c_str());
}

void test_parse_js_exec_error() {
  const auto cmd = airkvm::ParseCommandLine(
      "{\"type\":\"js.exec.error\",\"request_id\":\"js-1\",\"error_code\":\"js_exec_runtime_error\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(airkvm::CommandType::kJsExecError), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("js-1", cmd->request_id.c_str());
}

void test_ack_json_ok() {
  const auto s = airkvm::AckJson("abc", true);
  TEST_ASSERT_EQUAL_STRING("{\"id\":\"abc\",\"ok\":true}", s.c_str());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_parse_mouse_move_rel);
  RUN_TEST(test_parse_key_tap);
  RUN_TEST(test_parse_key_type);
  RUN_TEST(test_invalid_command);
  RUN_TEST(test_parse_state_set);
  RUN_TEST(test_parse_fw_version_request);
  RUN_TEST(test_parse_dom_snapshot_request);
  RUN_TEST(test_parse_screenshot_chunk);
  RUN_TEST(test_parse_tabs_list_request);
  RUN_TEST(test_parse_tab_open_request);
  RUN_TEST(test_parse_tab_open_error);
  RUN_TEST(test_parse_transfer_resume);
  RUN_TEST(test_parse_js_exec_request);
  RUN_TEST(test_parse_js_exec_result);
  RUN_TEST(test_parse_js_exec_error);
  RUN_TEST(test_ack_json_ok);
  return UNITY_END();
}
