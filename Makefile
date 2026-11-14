# Tacho for GNOME
#
#   make            build the installable zip in build/
#   make install    build, then install it for this user (gnome-extensions)
#   make test       run the parser tests (needs Node 18+)
#   make smoke      run the Gio readers under plain GJS against fixtures
#   make lint       ESLint (fetched with npx)
#   make pot        refresh po/ from the sources
#   make clean

UUID      := tacho@hieupnvmg.github.io
BUILD     := build
STAGE     := $(BUILD)/$(UUID)
ZIP       := $(BUILD)/$(UUID).shell-extension.zip

SOURCES   := extension.js prefs.js metadata.json stylesheet.css
LIBS      := $(wildcard lib/*.js)
ICONS     := $(wildcard icons/*.svg)
SCHEMA    := schemas/org.gnome.shell.extensions.tacho.gschema.xml
LANGS     := $(basename $(notdir $(wildcard po/*.po)))

.PHONY: all zip install uninstall test smoke lint pot clean check

all: zip

zip: $(ZIP)

$(ZIP): $(SOURCES) $(LIBS) $(ICONS) $(SCHEMA) $(wildcard po/*.po) LICENSE
	rm -rf $(STAGE) $(ZIP)
	mkdir -p $(STAGE)/lib $(STAGE)/icons $(STAGE)/schemas
	cp $(SOURCES) LICENSE $(STAGE)/
	cp $(LIBS) $(STAGE)/lib/
	cp $(ICONS) $(STAGE)/icons/
	cp $(SCHEMA) $(STAGE)/schemas/
	glib-compile-schemas --strict $(STAGE)/schemas
	for lang in $(LANGS); do \
		mkdir -p $(STAGE)/locale/$$lang/LC_MESSAGES; \
		msgfmt --check -o $(STAGE)/locale/$$lang/LC_MESSAGES/$(UUID).mo po/$$lang.po || exit 1; \
	done
	cd $(STAGE) && zip -qr ../$(UUID).shell-extension.zip .
	@echo "Built $(ZIP)"

install: $(ZIP)
	gnome-extensions install --force $(ZIP)
	@echo "Installed. On Wayland, log out and back in; on X11, press Alt+F2, type r, Enter."
	@echo "Then: gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions uninstall $(UUID)

check:
	glib-compile-schemas --strict --dry-run schemas
	for f in extension.js prefs.js lib/*.js; do node --check $$f || exit 1; done
	for lang in $(LANGS); do msgfmt --check -o /dev/null po/$$lang.po || exit 1; done

test:
	node --test test/*.test.js

smoke:
	gjs -m test/gjs-smoke.js

lint:
	npx --yes eslint@9 .

pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --add-comments=Translators \
		--package-name=tacho-gnome --msgid-bugs-address=https://github.com/hieupnvmg/tacho-gnome/issues \
		-o po/$(UUID).pot extension.js prefs.js lib/*.js
	for lang in $(LANGS); do msgmerge --quiet --update --backup=none po/$$lang.po po/$(UUID).pot; done

clean:
	rm -rf $(BUILD)
