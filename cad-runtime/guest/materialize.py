"""The guest runtime's script contract: `build(params)` returns a list of `Body`."""


class Body:
    """One printable body: a name the person sees, a filament slot, and a build123d shape."""

    __slots__ = ("name", "slot", "part")

    def __init__(self, name, slot, part):
        self.name = name
        self.slot = slot
        self.part = part
