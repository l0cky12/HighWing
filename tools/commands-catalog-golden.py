"""Writes src/hermes/commandsCatalogGolden.json: Hermes's `commands.catalog` answer, for hermesCommands.test.ts.

Runs Hermes's own `tui_gateway.command_discovery.command_catalog` at the deployed `bf0203a` with no quick commands, no
plugin commands and no skills, so the answer is Hermes's built-in commands alone, whatever the Hermes home holds.
Extract the deployed revision into an empty folder, then run from the repo root with a Python that has Hermes's
dependencies (the venv Hermes runs in):

    mkdir -p /tmp/hermes-bf0203a && git -C ~/.hermes/hermes-agent archive bf0203a | tar -x -C /tmp/hermes-bf0203a
    <hermes venv>/bin/python -I tools/commands-catalog-golden.py /tmp/hermes-bf0203a > src/hermes/commandsCatalogGolden.json
"""
import sys, types, json, logging
from importlib import import_module
sys.path.insert(0, sys.argv[1])
logging.disable(logging.CRITICAL)
from tui_gateway.command_discovery import command_catalog

skills = types.SimpleNamespace(get_interactive_skill_commands=lambda: {}, skill_command_collision_note=None)
plugins = types.SimpleNamespace(get_plugin_commands=lambda: {})
stubs = {"agent.skill_commands": skills, "hermes_cli.plugins": plugins}
catalog = command_catalog(load_cfg=lambda: {}, module_loader=lambda name: stubs.get(name) or import_module(name))
json.dump(catalog, sys.stdout, indent=1, ensure_ascii=False, sort_keys=True)
print()
