from __future__ import annotations

import importlib
import json
import platform
import sys


DEPENDENCY_PROFILES = {
    'core': (
        'openpyxl',
        'requests',
    ),
    'over_power': (
        'openpyxl',
        'requests',
        'flask',
        'pandas',
    ),
    'legacy': (
        'openpyxl',
        'requests',
        'flask',
        'pandas',
        'PIL',
        'matplotlib',
    ),
}


def dependency_modules(profile: str) -> tuple[str, ...]:
    modules = DEPENDENCY_PROFILES.get(profile)
    if modules is None:
        raise ValueError(f'unknown dependency profile: {profile}')
    if profile == 'legacy' and platform.system() == 'Windows':
        return (*modules, 'pythoncom', 'win32com.client')
    return modules


def main() -> int:
    profile = sys.argv[1].strip() if len(sys.argv) > 1 else ''
    try:
        modules = dependency_modules(profile)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    missing_or_broken: list[str] = []
    for module_name in modules:
        try:
            importlib.import_module(module_name)
        except Exception as exc:
            missing_or_broken.append(f'{module_name} ({type(exc).__name__})')

    if missing_or_broken:
        print(
            'missing_or_broken=' + ','.join(missing_or_broken),
            file=sys.stderr,
        )
        return 1

    print(
        json.dumps(
            {'ready': True, 'profile': profile, 'modules': modules},
            ensure_ascii=True,
        ),
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
