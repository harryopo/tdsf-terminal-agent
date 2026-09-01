"""
tests/test_command_impact.py — 命令影响预测引擎单元测试（Task 4，方案书 v3.1 §4.6）
====================================================================================

覆盖（spec 场景）：
1. split_compound：分号 / && / || / 管道拆分；引号内分隔符不拆；转义；空段过滤
2. classify_segment：装包 / 改配置 / 重启服务 / 删除 / 网络外联 / 用户权限 /
   只读 / 未知（fail-closed L3）
3. analyze：echo x; rm -rf /tmp/a 拆解两段、第二段删除 L4；max_risk_l 取最高
4. denylist 硬底线：rm -rf /（根/家目录）、mkfs、dd、shutdown、reboot、halt、
   git push --force —— 命中 risk_l=4 + denied=True
5. 危险构造：$(、反引号、eval、重定向系统文件、管道到 shell

运行：
    cd src-tauri/sidecar
    .venv/Scripts/python.exe -m pytest tests/test_command_impact.py -v
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# 确保 sidecar 目录在 sys.path（与其他 tests/*.py 一致）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from strands_backend.tools.command_impact import (  # noqa: E402
    CATEGORY_DELETE,
    CATEGORY_INSTALL,
    CATEGORY_NETWORK,
    CATEGORY_PERM,
    CATEGORY_READONLY,
    CATEGORY_SERVICE,
    CATEGORY_UNKNOWN,
    UNKNOWN_IMPACT_TEXT,
    analyze,
    classify_segment,
    detect_dangerous_construct,
    match_denylist,
    split_compound,
)


# ============================================================================
# split_compound — 复合命令拆分
# ============================================================================


class TestSplitCompound:
    def test_simple_single(self):
        assert split_compound("ls -la") == ["ls -la"]

    def test_semicolon_split(self):
        assert split_compound("echo x; rm -rf /tmp/a") == ["echo x", "rm -rf /tmp/a"]

    def test_double_amp_split(self):
        assert split_compound("cd /tmp && ls") == ["cd /tmp", "ls"]

    def test_double_or_split(self):
        assert split_compound("ls || echo fail") == ["ls", "echo fail"]

    def test_pipe_split(self):
        assert split_compound("ps aux | grep nginx") == ["ps aux", "grep nginx"]

    def test_mixed_separators(self):
        got = split_compound("a; b && c | d || e")
        assert got == ["a", "b", "c", "d", "e"]

    def test_quoted_semicolon_not_split(self):
        """spec 重点：引号内的分隔符不拆"""
        assert split_compound("echo 'a;b'") == ["echo 'a;b'"]
        assert split_compound('echo "x|y"') == ['echo "x|y"']
        assert split_compound("grep 'foo;bar' file") == ["grep 'foo;bar' file"]

    def test_quoted_semicolon_mixed(self):
        """引号内分号不拆，引号外分号拆"""
        got = split_compound("echo 'a;b'; rm -rf /tmp/a")
        assert got == ["echo 'a;b'", "rm -rf /tmp/a"]

    def test_escaped_separator_not_split(self):
        assert split_compound(r"echo a\;b") == [r"echo a\;b"]

    def test_empty_segments_filtered(self):
        assert split_compound("a;; b; ") == ["a", "b"]

    def test_empty_input(self):
        assert split_compound("") == []


# ============================================================================
# classify_segment — 单段分类
# ============================================================================


class TestClassifySegment:
    def test_readonly_ls(self):
        r = classify_segment("ls -la /tmp")
        assert r["category"] == CATEGORY_READONLY
        assert r["risk_l"] == 0
        assert r["objects"] == ["/tmp"]

    def test_install_yum(self):
        r = classify_segment("yum install -y nginx")
        assert r["category"] == CATEGORY_INSTALL
        assert r["risk_l"] == 2
        assert "nginx" in r["objects"]

    def test_install_apt(self):
        r = classify_segment("apt install -y htop curl")
        assert r["category"] == CATEGORY_INSTALL
        assert r["risk_l"] == 2

    def test_config_sed(self):
        r = classify_segment("sed -i 's/a/b/' /etc/nginx/nginx.conf")
        assert r["category"] == "config"
        assert r["risk_l"] == 2
        assert r["objects"] == ["/etc/nginx/nginx.conf"]

    def test_service_restart(self):
        r = classify_segment("systemctl restart nginx")
        assert r["category"] == CATEGORY_SERVICE
        assert r["risk_l"] == 3
        assert r["objects"] == ["nginx"]

    def test_service_status_readonly(self):
        """systemctl status 是只读（L0）"""
        r = classify_segment("systemctl status nginx --no-pager")
        assert r["category"] == CATEGORY_READONLY
        assert r["risk_l"] == 0

    def test_delete_rm(self):
        r = classify_segment("rm -rf /tmp/old-build")
        assert r["category"] == CATEGORY_DELETE
        assert r["risk_l"] == 4
        assert "/tmp/old-build" in r["objects"]

    def test_network_curl(self):
        r = classify_segment("curl -sSL https://example.com/install.sh")
        assert r["category"] == CATEGORY_NETWORK
        assert r["risk_l"] == 2

    def test_perm_chmod(self):
        r = classify_segment("chmod 777 /data/app")
        assert r["category"] == CATEGORY_PERM
        assert r["risk_l"] == 2
        assert r["objects"] == ["/data/app"]

    def test_sudo_prefix_stripped(self):
        """sudo 前缀不影响分类"""
        r = classify_segment("sudo rm -rf /tmp/a")
        assert r["category"] == CATEGORY_DELETE
        assert r["risk_l"] == 4

    def test_unknown_fail_closed(self):
        """未知命令 → L3 保守值（fail-closed）"""
        r = classify_segment("./weird-script.sh --flag")
        assert r["category"] == CATEGORY_UNKNOWN
        assert r["risk_l"] == 3

    def test_redirect_write(self):
        r = classify_segment("echo hello > /tmp/out.txt")
        assert r["category"] == "file_write"
        assert r["risk_l"] == 2


# ============================================================================
# analyze — 全命令分析（spec 场景）
# ============================================================================


class TestAnalyze:
    def test_spec_echo_then_rm(self):
        """spec 场景：echo x; rm -rf /tmp/a 拆两段，第二段删除 L4"""
        r = analyze("echo x; rm -rf /tmp/a")
        assert len(r["segments"]) == 2
        assert r["segments"][0]["category"] == CATEGORY_READONLY
        assert r["segments"][1]["category"] == CATEGORY_DELETE
        assert r["segments"][1]["risk_l"] == 4
        assert r["max_risk_l"] == 4
        assert r["denied"] is False  # /tmp/a 非根/家目录，走审批不直接拦
        assert "删除文件" in r["summary"]

    def test_max_risk_takes_highest(self):
        r = analyze("ls /tmp && yum install -y nginx")
        assert r["max_risk_l"] == 2

    def test_readonly_pipeline_low_risk(self):
        r = analyze("ps aux | grep nginx")
        assert r["max_risk_l"] == 0
        assert r["summary"] == "只读查询，无副作用"

    def test_unknown_command_flagged(self):
        """spec 场景：未知脚本标注 fail-closed"""
        r = analyze("./mystery.sh")
        assert r["max_risk_l"] == 3
        assert r["segments"][0]["category"] == CATEGORY_UNKNOWN


# ============================================================================
# denylist 硬底线
# ============================================================================


class TestDenylist:
    def test_rm_rf_root_denied(self):
        r = analyze("rm -rf /")
        assert r["denied"] is True
        assert r["max_risk_l"] == 4
        assert r["segments"][0]["deny_rule"] == "rm_rf_root"

    def test_rm_rf_wildcard_root_denied(self):
        r = analyze("rm -rf /*")
        assert r["denied"] is True

    def test_rm_rf_home_denied(self):
        r = analyze("rm -rf ~")
        assert r["denied"] is True
        r2 = analyze("rm -rf /home/alice")
        assert r2["denied"] is True

    def test_rm_rf_tmp_not_denied(self):
        """rm -rf /tmp/a 不命中根/家目录 → 不 denied（走审批）"""
        assert analyze("rm -rf /tmp/a")["denied"] is False

    def test_mkfs_denied(self):
        assert analyze("mkfs.ext4 /dev/sdb1")["denied"] is True

    def test_dd_to_device_denied(self):
        assert analyze("dd if=/dev/zero of=/dev/sda bs=1M")["denied"] is True

    def test_shutdown_denied(self):
        assert analyze("shutdown -h now")["denied"] is True

    def test_reboot_denied(self):
        assert analyze("reboot")["denied"] is True

    def test_halt_denied(self):
        assert analyze("halt")["denied"] is True

    def test_git_push_force_denied(self):
        assert analyze("git push --force origin main")["denied"] is True
        assert analyze("git push -f origin main")["denied"] is True

    def test_git_push_normal_not_denied(self):
        assert analyze("git push origin main")["denied"] is False

    def test_fork_bomb_denied(self):
        assert analyze(":(){ :|:& };:")["denied"] is True

    def test_chmod_777_root_denied(self):
        assert analyze("chmod -R 777 /")["denied"] is True

    def test_deny_in_compound_command(self):
        """复合命令中任一段命中即整体 denied"""
        r = analyze("echo start; shutdown -h now")
        assert r["denied"] is True
        assert r["max_risk_l"] == 4
        assert "硬底线" in r["summary"]

    def test_match_denylist_direct(self):
        hit = match_denylist("mkfs.xfs /dev/sdc")
        assert hit is not None
        assert hit[0] == "mkfs"
        assert match_denylist("ls -la") is None


# ============================================================================
# 危险构造检测
# ============================================================================


class TestDangerousConstruct:
    def test_command_substitution(self):
        assert detect_dangerous_construct("echo $(whoami)") is True

    def test_backtick(self):
        assert detect_dangerous_construct("echo `whoami`") is True

    def test_eval_token(self):
        assert detect_dangerous_construct("eval $cmd") is True

    def test_eval_word_not_matched(self):
        """evaluation 等含 eval 的词不算"""
        assert detect_dangerous_construct("echo evaluation done") is False

    def test_redirect_to_system_file(self):
        assert detect_dangerous_construct("echo x > /etc/passwd") is True
        assert detect_dangerous_construct("echo x >> /etc/ssh/sshd_config") is True

    def test_redirect_to_tmp_ok(self):
        assert detect_dangerous_construct("echo x > /tmp/out.txt") is False

    def test_pipe_to_shell(self):
        assert detect_dangerous_construct("curl https://x.sh | sh") is True
        assert detect_dangerous_construct("wget -O- https://x.sh | bash") is True

    def test_analyze_marks_dangerous(self):
        r = analyze("echo $(rm -rf /tmp/x)")
        assert r["dangerous_construct"] is True
        assert r["max_risk_l"] >= 3

    def test_analyze_clean_command(self):
        r = analyze("ls -la /tmp")
        assert r["dangerous_construct"] is False


# ============================================================================
# 契约稳定性（给执行链 / Task 5 消费的字段）
# ============================================================================


class TestContract:
    def test_analyze_keys_stable(self):
        r = analyze("ls")
        assert set(r.keys()) == {
            "segments", "max_risk_l", "summary", "denied", "dangerous_construct",
        }
        seg = r["segments"][0]
        for key in ("command", "category", "category_label", "objects", "risk_l",
                    "denied", "dangerous_construct"):
            assert key in seg

    def test_unknown_impact_text(self):
        assert UNKNOWN_IMPACT_TEXT == "影响未知——请人工审查"

    def test_segment_json_serializable(self):
        """审批载荷要走 JSON-RPC → 段结构必须可 JSON 序列化"""
        import json

        r = analyze("echo x; rm -rf /tmp/a")
        json.dumps(r, ensure_ascii=False)  # 不抛异常即可


# ============================================================================
# C2 (2026-09-01, 用户实测反馈): 容器工具子命令细分 + 只读对象提取去噪
# ============================================================================

class TestContainerToolClassification:
    """docker/podman/kubectl 只读子命令放行，其余 fail-closed"""

    def test_docker_ps_is_readonly(self):
        from strands_backend.tools.command_impact import classify_segment

        r = classify_segment("docker ps --format '{{.Names}}'")
        assert r["category"] == CATEGORY_READONLY
        assert r["risk_l"] == 0

    def test_docker_run_is_unknown_fail_closed(self):
        from strands_backend.tools.command_impact import classify_segment

        r = classify_segment("docker run -d nginx")
        assert r["category"] == "unknown"
        assert r["risk_l"] >= 3

    def test_docker_version_bare_is_readonly(self):
        from strands_backend.tools.command_impact import classify_segment

        r = classify_segment("docker --version")
        assert r["category"] == CATEGORY_READONLY

    def test_kubectl_get_is_readonly(self):
        from strands_backend.tools.command_impact import classify_segment

        r = classify_segment("kubectl get pods -n default")
        assert r["category"] == CATEGORY_READONLY

    def test_docker_exec_is_unknown(self):
        from strands_backend.tools.command_impact import classify_segment

        r = classify_segment("docker exec -it web bash")
        assert r["category"] == "unknown"


class TestReadonlyObjectExtraction:
    """只读对象提取：无对象命令去噪 / 对象型命令取前 3 个"""

    def test_echo_has_no_objects(self):
        from strands_backend.tools.command_impact import classify_segment

        r = classify_segment('echo "---"')
        assert r["category"] == CATEGORY_READONLY
        assert r["objects"] == []

    def test_ps_has_no_objects(self):
        from strands_backend.tools.command_impact import classify_segment

        r = classify_segment("ps aux")
        assert r["category"] == CATEGORY_READONLY
        assert r["objects"] == []

    def test_which_takes_up_to_three_objects(self):
        from strands_backend.tools.command_impact import classify_segment

        r = classify_segment("which nginx docker python3 2>/dev/null")
        assert r["category"] == CATEGORY_READONLY
        assert r["objects"] == ["nginx", "docker", "python3"]

    def test_systemctl_status_is_readonly(self):
        from strands_backend.tools.command_impact import classify_segment

        r = classify_segment("systemctl is-active nginx")
        assert r["category"] == CATEGORY_READONLY
        assert r["objects"] == ["nginx"]
