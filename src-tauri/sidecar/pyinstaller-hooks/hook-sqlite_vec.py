from PyInstaller.utils.hooks import collect_dynamic_libs

binaries = collect_dynamic_libs(
    "sqlite_vec", search_patterns=["*.dll", "*.so", "*.dylib"]
)
