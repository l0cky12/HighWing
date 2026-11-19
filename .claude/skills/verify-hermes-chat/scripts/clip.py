# Owns the X CLIPBOARD with one image until killed, so a real Ctrl+V in the app pastes it as a screenshot would.
# Run it on the run's display, in the background: DISPLAY=$DISPLAY_NUM python3 clip.py <image>, after `. $HV_RUN/state.env`
import sys, gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GdkPixbuf
pb = GdkPixbuf.Pixbuf.new_from_file(sys.argv[1])
Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_image(pb)
print("clip: owning", sys.argv[1], flush=True)
Gtk.main()
