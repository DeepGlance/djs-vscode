/// Small geometry types: the public fixture of the djs-vscode host tests (BSL-1.0, see LICENSE).
module geom;

/// A vector of two components.
struct Vec(T)
{
    T x, y;

    /// Componentwise sum.
    Vec opBinary(string op : "+")(Vec other) const
    {
        return Vec(x + other.x, y + other.y);
    }
}

/// The squared length of `v`.
T length2(T)(Vec!T v)
{
    return v.x * v.x + v.y * v.y;
}

/// A vector with a name, usable as its vector.
struct Named
{
    string name;
    Vec!int vec;
    alias vec this;
}
