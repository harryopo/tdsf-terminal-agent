use super::decode_command_output;

#[test]
fn chinese_character_survives_a_split_packet() {
    let mut pending = Vec::new();

    assert_eq!(
        decode_command_output(&mut pending, &[0xE4, 0xB8], false),
        ""
    );
    assert_eq!(pending, [0xE4, 0xB8]);
    assert_eq!(decode_command_output(&mut pending, &[0xAD], false), "中");
    assert!(pending.is_empty());
}

#[test]
fn four_byte_emoji_survives_every_split_point() {
    let bytes = "🙂".as_bytes();

    for split in 1..bytes.len() {
        let mut pending = Vec::new();
        let first = decode_command_output(&mut pending, &bytes[..split], false);
        let second = decode_command_output(&mut pending, &bytes[split..], false);

        assert_eq!(format!("{first}{second}"), "🙂", "split at {split}");
        assert!(pending.is_empty(), "split at {split}");
    }
}

#[test]
fn valid_ascii_prefix_is_emitted_while_a_character_is_incomplete() {
    let mut pending = Vec::new();
    let bytes = "ok🙂".as_bytes();

    assert_eq!(
        decode_command_output(&mut pending, &bytes[..4], false),
        "ok"
    );
    assert_eq!(pending, [0xF0, 0x9F]);
    assert_eq!(
        decode_command_output(&mut pending, &bytes[4..], false),
        "🙂"
    );
}

#[test]
fn mixed_utf8_is_preserved_at_every_packet_boundary() {
    let text = "A中文🙂Z";
    let bytes = text.as_bytes();

    for split in 0..=bytes.len() {
        let mut pending = Vec::new();
        let first = decode_command_output(&mut pending, &bytes[..split], false);
        assert!(pending.len() <= 3, "first packet split at {split}");
        let second = decode_command_output(&mut pending, &bytes[split..], false);
        assert!(pending.len() <= 3, "second packet split at {split}");
        let final_chunk = decode_command_output(&mut pending, &[], true);

        assert_eq!(
            format!("{first}{second}{final_chunk}"),
            text,
            "split at {split}"
        );
        assert!(pending.is_empty(), "split at {split}");
    }
}

#[test]
fn bytewise_packets_preserve_mixed_utf8_and_bound_pending() {
    let bytes = "x中文🙂y".as_bytes();
    let mut pending = Vec::new();
    let mut output = String::new();

    for byte in bytes {
        output.push_str(&decode_command_output(&mut pending, &[*byte], false));
        assert!(pending.len() <= 3);
    }
    output.push_str(&decode_command_output(&mut pending, &[], true));

    assert_eq!(output, "x中文🙂y");
    assert!(pending.is_empty());
}

#[test]
fn invalid_bytes_match_whole_buffer_lossy_decoding() {
    let samples: &[&[u8]] = &[
        &[b'a', 0xFF, b'b'],
        &[0x80, 0x81, b'x'],
        &[b'a', 0xE4, 0x28, 0xA1, b'z'],
        &[0xF0, 0x9F, 0x92, b'!'],
    ];

    for bytes in samples {
        let mut pending = Vec::new();
        let mut output = String::new();
        for byte in *bytes {
            output.push_str(&decode_command_output(&mut pending, &[*byte], false));
            assert!(pending.len() <= 3);
        }
        output.push_str(&decode_command_output(&mut pending, &[], true));

        assert_eq!(output, String::from_utf8_lossy(bytes));
        assert!(pending.is_empty());
    }
}

#[test]
fn incomplete_tail_is_replaced_only_when_finished_and_only_once() {
    let mut pending = Vec::new();

    assert_eq!(
        decode_command_output(&mut pending, &[0xF0, 0x9F, 0x99], false),
        ""
    );
    assert_eq!(pending, [0xF0, 0x9F, 0x99]);
    assert_eq!(decode_command_output(&mut pending, &[], true), "\u{fffd}");
    assert!(pending.is_empty());
    assert_eq!(decode_command_output(&mut pending, &[], true), "");
}

#[test]
fn invalid_prefix_is_emitted_while_following_utf8_tail_is_pending() {
    let mut pending = Vec::new();

    assert_eq!(
        decode_command_output(&mut pending, &[0xFF, b'a', 0xE4, 0xB8], false),
        "\u{fffd}a"
    );
    assert_eq!(pending, [0xE4, 0xB8]);
    assert_eq!(decode_command_output(&mut pending, &[0xAD], false), "中");
    assert!(pending.is_empty());
}

#[test]
fn empty_packet_does_not_discard_an_incomplete_character() {
    let mut pending = Vec::new();

    assert_eq!(decode_command_output(&mut pending, &[0xE4], false), "");
    assert_eq!(decode_command_output(&mut pending, &[], false), "");
    assert_eq!(pending, [0xE4]);
    assert_eq!(
        decode_command_output(&mut pending, &[0xB8, 0xAD], false),
        "中"
    );
}

#[test]
fn stdout_and_stderr_pending_bytes_are_independent() {
    let mut stdout_pending = Vec::new();
    let mut stderr_pending = Vec::new();

    assert_eq!(
        decode_command_output(&mut stdout_pending, &[0xE4], false),
        ""
    );
    assert_eq!(
        decode_command_output(&mut stderr_pending, &[0xF0, 0x9F], false),
        ""
    );
    assert_eq!(
        decode_command_output(&mut stdout_pending, &[0xB8, 0xAD], false),
        "中"
    );
    assert_eq!(
        decode_command_output(&mut stderr_pending, &[0x99, 0x82], false),
        "🙂"
    );
    assert!(stdout_pending.is_empty());
    assert!(stderr_pending.is_empty());
}

#[test]
fn separate_commands_do_not_share_pending_bytes() {
    let mut first_command = Vec::new();
    let mut second_command = Vec::new();
    let second_text = "界".as_bytes();

    assert_eq!(
        decode_command_output(&mut first_command, &[0xE4], false),
        ""
    );
    assert_eq!(
        decode_command_output(&mut second_command, &second_text[..1], false),
        ""
    );
    assert_eq!(
        decode_command_output(&mut first_command, &[0xB8, 0xAD], false),
        "中"
    );
    assert_eq!(
        decode_command_output(&mut second_command, &second_text[1..], false),
        "界"
    );
    assert!(first_command.is_empty());
    assert!(second_command.is_empty());
}

#[test]
fn ansi_and_large_ascii_chunks_are_emitted_immediately() {
    let mut pending = Vec::new();
    let ansi = b"\x1b[31merror\x1b[0m\n";
    let large = vec![b'x'; 64 * 1024];

    assert_eq!(
        decode_command_output(&mut pending, ansi, false),
        "\x1b[31merror\x1b[0m\n"
    );
    assert_eq!(
        decode_command_output(&mut pending, &large, false),
        "x".repeat(64 * 1024)
    );
    assert!(pending.is_empty());
}
