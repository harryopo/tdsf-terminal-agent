# Test-only model of printf implementations that return signed byte ordinals.
printf() {
  local index ordinal
  local args=("$@")
  for ((index=0; index<${#args[@]}; index++)); do
    if [[ ${args[$index]} == "'"* ]]; then
      ordinal=$(builtin printf '%d' "${args[$index]}")
      if ((ordinal >= 128 && ordinal <= 255)); then
        args[$index]=$((ordinal - 256))
      fi
    fi
  done
  builtin printf "${args[@]}"
}
