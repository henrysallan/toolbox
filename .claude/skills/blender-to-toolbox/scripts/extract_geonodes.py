"""
Dump the open .blend's geometry-node trees as compact, translation-ready text.

Send the whole file as the `code` argument of blender-mcp's
execute_blender_code. It prints; blender-mcp returns stdout.

Edit the CONFIG block before sending when a file is large — an unfiltered
dump of a heavy production file can exceed what the MCP round-trip will
carry, and a truncated tree is worse than a scoped one.

What this captures that a hand-written dump usually misses:
  - default_value on UNCONNECTED inputs, where most of a tree's real
    configuration lives (a Distribute Points node's density is a socket,
    not a property)
  - node-level enum properties — a Math node is meaningless without
    operation=MULTIPLY, a Mix without data_type/blend_type, a Capture
    Attribute without domain
  - Geometry Nodes MODIFIER inputs, which live on the object and not in
    the tree at all, so a tree-only read silently reports the group
    defaults instead of what the user actually set
  - socket.enabled, so mode-hidden sockets (a Math node's unused third
    operand) don't pollute the output
  - nested node groups, muted nodes, and reroutes
"""

import bpy

# ------------------------------ CONFIG --------------------------------
TREE_FILTER = ""      # substring match on tree name; "" = every geometry tree
OBJECT_FILTER = ""    # substring match on object name; "" = every object
MAX_CHARS = 60000     # hard cap on printed output
SHOW_DEFAULTS = True  # print unconnected input default values
# ----------------------------------------------------------------------

_out = []
_size = 0
_truncated = False


def emit(line=""):
    global _size, _truncated
    if _truncated:
        return
    if _size + len(line) + 1 > MAX_CHARS:
        _out.append("")
        _out.append("!! OUTPUT TRUNCATED at MAX_CHARS — re-run with a "
                    "TREE_FILTER to scope the dump.")
        _truncated = True
        return
    _out.append(line)
    _size += len(line) + 1


def fmt(v):
    """Compact, stable formatting for socket/property values."""
    if v is None:
        return "None"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        if v == int(v) and abs(v) < 1e9:
            return str(int(v))
        return f"{v:.4g}"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return f'"{v}"' if (" " in v or v == "") else v
    # bpy_prop_array / Vector / Color / Euler
    try:
        items = list(v)
    except TypeError:
        return str(v)
    return "[" + ",".join(fmt(x) for x in items) + "]"


# Node properties that every node has — excluded so only the meaningful
# per-node settings (operation, domain, data_type, mode…) survive.
_BASE_PROPS = set()
for _cls_name in ("Node", "NodeInternal", "GeometryNode", "ShaderNode",
                  "FunctionNode", "NodeGroup"):
    _cls = getattr(bpy.types, _cls_name, None)
    if _cls is not None:
        try:
            _BASE_PROPS |= set(_cls.bl_rna.properties.keys())
        except Exception:
            pass


def node_props(node):
    """Node-level settings — the enums that give a node its actual meaning."""
    props = {}
    for p in node.bl_rna.properties:
        ident = p.identifier
        if ident in _BASE_PROPS or p.is_readonly:
            continue
        if p.type not in {"ENUM", "BOOLEAN", "INT", "FLOAT", "STRING"}:
            continue
        try:
            props[ident] = getattr(node, ident)
        except Exception:
            continue
    return props


def sock_default(sock):
    """Unconnected input's value, or None when the socket carries no value."""
    if not hasattr(sock, "default_value"):
        return None
    try:
        return sock.default_value
    except Exception:
        return None


def node_id(node):
    return node.name


def describe_tree(tree, seen):
    """Emit one node tree; returns nested group trees to visit."""
    nested = []
    emit(f"TREE {fmt(tree.name)}  nodes={len(tree.nodes)} "
         f"links={len(tree.links)}")

    # from_socket -> [(to_node, to_socket), ...]
    outgoing = {}
    for link in tree.links:
        key = (link.from_node.name, link.from_socket.identifier)
        outgoing.setdefault(key, []).append(
            (link.to_node.name, link.to_socket.name))
    # (to_node, to_socket_identifier) -> (from_node, from_socket)
    incoming = {}
    for link in tree.links:
        incoming[(link.to_node.name, link.to_socket.identifier)] = (
            link.from_node.name, link.from_socket.name)

    for node in tree.nodes:
        flags = []
        if node.mute:
            flags.append("MUTED")
        if node.bl_idname == "NodeReroute":
            flags.append("REROUTE")
        flag_s = (" " + " ".join(flags)) if flags else ""

        label = f" label={fmt(node.label)}" if node.label else ""
        props = node_props(node)
        prop_s = ""
        if props:
            prop_s = "  " + " ".join(f"{k}={fmt(v)}" for k, v in props.items())

        emit(f"  NODE {node_id(node)}  {node.bl_idname}{flag_s}{label}{prop_s}")

        if node.bl_idname == "GeometryNodeGroup" and node.node_tree:
            emit(f"    GROUP -> {fmt(node.node_tree.name)}")
            if node.node_tree.name not in seen:
                nested.append(node.node_tree)

        for sock in node.inputs:
            if not sock.enabled or sock.hide:
                continue
            src = incoming.get((node.name, sock.identifier))
            if src:
                multi = " (multi)" if getattr(sock, "is_multi_input", False) else ""
                emit(f"    IN  {sock.name} <- {src[0]}.{src[1]}{multi}")
            elif SHOW_DEFAULTS:
                dv = sock_default(sock)
                if dv is not None:
                    emit(f"    IN  {sock.name} = {fmt(dv)}")

        for sock in node.outputs:
            if not sock.enabled:
                continue
            targets = outgoing.get((node.name, sock.identifier))
            if targets:
                tgt_s = ", ".join(f"{n}.{s}" for n, s in targets)
                emit(f"    OUT {sock.name} -> {tgt_s}")

    emit()
    return nested


def describe_modifier_inputs(obj, mod):
    """The values the USER set on the modifier — absent from the tree itself."""
    tree = mod.node_group
    emit(f"MODIFIER {fmt(obj.name)} / {fmt(mod.name)} -> tree {fmt(tree.name)}")

    interface = getattr(tree, "interface", None)
    entries = []
    if interface is not None and hasattr(interface, "items_tree"):
        # Blender 4.x
        for item in interface.items_tree:
            if getattr(item, "item_type", "") != "SOCKET":
                continue
            if getattr(item, "in_out", "") != "INPUT":
                continue
            entries.append((item.name, item.identifier,
                            getattr(item, "socket_type", "?")))
    else:
        # Blender 3.x
        for sock in getattr(tree, "inputs", []):
            entries.append((sock.name, sock.identifier,
                            getattr(sock, "bl_socket_idname", "?")))

    if not entries:
        emit("    (no exposed group inputs)")
        emit()
        return

    for name, ident, stype in entries:
        try:
            val = mod[ident]
        except (KeyError, TypeError):
            emit(f"    {name} [{ident}] : {stype} = <group default>")
            continue
        emit(f"    {name} [{ident}] : {stype} = {fmt(val)}")
    emit()


def main():
    trees = [t for t in bpy.data.node_groups
             if getattr(t, "bl_idname", "") == "GeometryNodeTree"
             and (not TREE_FILTER or TREE_FILTER.lower() in t.name.lower())]

    emit(f"BLENDER {bpy.app.version_string}   "
         f"geometry trees matched: {len(trees)}")
    emit()

    # Modifier-level inputs first: they are what the user actually tuned.
    for obj in bpy.data.objects:
        if OBJECT_FILTER and OBJECT_FILTER.lower() not in obj.name.lower():
            continue
        for mod in obj.modifiers:
            if mod.type != "NODES" or not mod.node_group:
                continue
            if TREE_FILTER and TREE_FILTER.lower() not in mod.node_group.name.lower():
                continue
            describe_modifier_inputs(obj, mod)

    seen = set()
    queue = list(trees)
    while queue:
        tree = queue.pop(0)
        if tree.name in seen:
            continue
        seen.add(tree.name)
        queue.extend(describe_tree(tree, seen))

    # A histogram makes the translation surface visible at a glance: check
    # each distinct node family against references/node-map.md.
    histogram = {}
    for name in seen:
        tree = bpy.data.node_groups.get(name)
        if not tree:
            continue
        for node in tree.nodes:
            histogram[node.bl_idname] = histogram.get(node.bl_idname, 0) + 1
    emit("NODE TYPES USED (check each against references/node-map.md)")
    for idname, count in sorted(histogram.items(), key=lambda kv: -kv[1]):
        emit(f"  {count:3d}  {idname}")

    print("\n".join(_out))


main()
