package net.leviro.levix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import org.w3c.dom.Node
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * The Battery Guard title row must not give the status badge the width first.
 * Gradle runs this with android/app as the working directory.
 */
class BatteryCardLayoutTest {
    private val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(layoutFile())

    @Test fun batteryBadgeIsNotBesideTheWeightedColumn() {
        val card = elementById("cardBattery")
        val column = card.elements().single { it.attr("layout_weight") == "1" }
        val badge = elementById("batteryBadge")
        val row = column.parentNode as Element
        assertFalse(badge.parentNode === column.parentNode)
        val insideColumn = badge.hasAncestor(column)
        val belowRow = !badge.hasAncestor(row) && badge.hasAncestor(card)
        assertTrue(insideColumn || belowRow)
    }

    @Test fun titleAndHintDoNotHyphenate() {
        val card = elementById("cardBattery")
        val title = card.elements().single { it.attr("text") == "@string/card_battery_title" }
        val hint = elementById("batteryHint")
        assertEquals("none", title.attr("hyphenationFrequency"))
        assertEquals("none", hint.attr("hyphenationFrequency"))
    }

    private fun elementById(id: String): Element {
        val found = document.documentElement.elements().filter { element ->
            val value = element.attr("id")
            value == "@+id/$id" || value == "@id/$id"
        }
        assertEquals("id $id", 1, found.size)
        return found.single()
    }

    private fun Element.elements(): List<Element> {
        val out = ArrayList<Element>()
        fun walk(node: Element) {
            out.add(node)
            val children = node.childNodes
            for (i in 0 until children.length) {
                val child = children.item(i)
                if (child is Element) walk(child)
            }
        }
        val children = childNodes
        for (i in 0 until children.length) {
            val child = children.item(i)
            if (child is Element) walk(child)
        }
        return out
    }

    private fun Element.hasAncestor(ancestor: Element): Boolean {
        var node: Node? = parentNode
        while (node != null) {
            if (node === ancestor) return true
            node = node.parentNode
        }
        return false
    }

    private fun Element.attr(name: String): String? {
        val prefixed = "android:$name"
        return when {
            hasAttribute(prefixed) -> getAttribute(prefixed)
            hasAttribute(name) -> getAttribute(name)
            else -> null
        }
    }

    private fun layoutFile(): File {
        val file = File("src/main/res/layout/activity_main.xml")
        assertTrue(file.absolutePath, file.isFile)
        return file
    }
}
