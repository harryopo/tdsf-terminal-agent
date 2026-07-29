//! 容器内命令执行 (P2-C T-P2-08.2)
//! ============================================================================
//! 封装 bollard create_exec + start_exec 流程,提供高层 API:
//! - `create_exec`: 创建 exec 实例 (返回 exec_id)
//! - `start_exec`: 启动 exec 并收集 stdout/stderr/exit_code 到 ExecOutput
//!
//! ## 流程
//! ```text
//! [Create Exec]  docker.create_container(&id, ExecConfig{cmd, ...})
//!      │
//!      ▼  返回 exec_id
//! [Start Exec]   docker.start_exec(&exec_id, None)
//!      │
//!      ▼  返回 StartExecResults::Attached { output, input }
//! [Consume Stream]  遍历 output Stream,收集 LogOutput
//!      │
//!      ▼
//! [Inspect]      docker.inspect_exec(&exec_id) 获取 ExitCode
//!      │
//!      ▼  返回 ExecOutput { stdout, stderr, exit_code }
//! ```
//!
//! ## 注意
//! - 不支持交互式 TTY (TTY 需要持续写 input,适合后续按需扩展)
//! - stdout/stderr 通过 LogOutput 区分 (StdOut / StdErr / Console)
//! - 退出码通过 inspect_exec 获取 (流结束不代表退出码可读)

use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::Docker;
use futures_util::stream::StreamExt;

use super::config::ExecOutput;

/// 创建 exec 实例
///
/// 参数:
/// - `docker`: bollard Docker 客户端
/// - `container_id`: 目标容器 ID
/// - `cmd`: 要执行的命令 (含参数,如 `["ls", "-l", "/"]`)
///
/// 返回: exec_id (供 start_exec 使用)
///
/// 错误:
/// - 容器不存在 / 容器未启动 → bollard Error
/// - cmd 为空 → 显式错误
pub async fn create_exec(
    docker: &Docker,
    container_id: &str,
    cmd: &[String],
) -> Result<String, String> {
    if cmd.is_empty() {
        return Err("exec cmd must not be empty".to_string());
    }

    log::debug!(
        "[sandbox.exec] create_exec: container={} cmd={:?}",
        container_id,
        cmd
    );

    let config = CreateExecOptions::<String> {
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        cmd: Some(cmd.to_vec()),
        ..Default::default()
    };

    let result = docker
        .create_exec(container_id, config)
        .await
        .map_err(|e| format!("create_exec failed: {e}"))?;

    log::debug!("[sandbox.exec] exec created: id={}", result.id);
    Ok(result.id)
}

/// 启动 exec 并收集输出
///
/// 参数:
/// - `docker`: bollard Docker 客户端
/// - `exec_id`: create_exec 返回的 ID
///
/// 返回: ExecOutput { stdout, stderr, exit_code }
///
/// 流程:
/// 1. start_exec 获取 Attached { output, input }
/// 2. 遍历 output Stream,按 LogOutput 类型分发到 stdout/stderr
/// 3. 流结束后 inspect_exec 获取退出码
///
/// 注意: 当前不写 input (非交互式),如需 TTY 交互需扩展。
pub async fn start_exec(docker: &Docker, exec_id: &str) -> Result<ExecOutput, String> {
    log::debug!("[sandbox.exec] start_exec: id={}", exec_id);

    let start_result = docker
        .start_exec(exec_id, None)
        .await
        .map_err(|e| format!("start_exec failed: {e}"))?;

    let mut result_output = ExecOutput::default();

    match start_result {
        StartExecResults::Attached { mut output, .. } => {
            // 消费整个流,按消息类型分发到 result_output
            while let Some(msg) = output.next().await {
                match msg {
                    Ok(log) => {
                        use bollard::container::LogOutput;
                        match log {
                            LogOutput::StdOut { message } => {
                                result_output.stdout.extend_from_slice(&message);
                            }
                            LogOutput::StdErr { message } => {
                                result_output.stderr.extend_from_slice(&message);
                            }
                            LogOutput::Console { message } => {
                                // Console (含 TTY 时混在一起) 默认归入 stdout
                                result_output.stdout.extend_from_slice(&message);
                            }
                            LogOutput::StdIn { .. } => {
                                // 忽略 stdin 回显
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("[sandbox.exec] stream error: {}", e);
                        result_output.stderr.extend_from_slice(
                            format!("[stream error: {e}]").as_bytes(),
                        );
                        break;
                    }
                }
            }
        }
        StartExecResults::Detached => {
            // Detached 模式下无法获取输出,返回空
            log::warn!("[sandbox.exec] exec is detached, no output collected");
        }
    }

    // 通过 inspect_exec 获取退出码
    let inspect = docker
        .inspect_exec(exec_id)
        .await
        .map_err(|e| format!("inspect_exec failed: {e}"))?;

    // ExitCode 在 ExecInspect 的 ProcessConfig 之外,直接在根字段
    // bollard 0.17: ExecInspectResponse { exit_code: Option<i64>, ... }
    result_output.exit_code = inspect.exit_code.unwrap_or(-1);

    log::info!(
        "[sandbox.exec] exec done: id={} exit={} stdout={}B stderr={}B",
        exec_id,
        result_output.exit_code,
        result_output.stdout.len(),
        result_output.stderr.len()
    );

    Ok(result_output)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 测试 create_exec 拒绝空 cmd
    #[test]
    fn test_create_exec_rejects_empty_cmd() {
        // 同步部分无法测 docker 调用,但空 cmd 检查在调用前
        // 这里仅验证逻辑路径(无 Docker 时通过)
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("rt build failed");

        // 不连真实 Docker,只验证空 cmd 早返回错误
        let docker = Docker::connect_with_local_defaults().unwrap();
        let result = rt.block_on(create_exec(&docker, "fake_id", &[]));
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("must not be empty"), "unexpected err: {err}");
    }
}
