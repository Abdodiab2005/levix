package net.leviro.levix

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.doOnLayout
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView

/**
 * A product-tour overlay drawn over the real home screen: a translucent scrim
 * with a rounded hole around the control being described, a soft brand glow
 * around the hole, and one card that explains the step.
 *
 * It owns no WhatsApp or host logic. Everything it needs comes from [Host],
 * which is the screen underneath: find a target, scroll it into view, and be
 * told when the tour ends.
 */
class CoachMarkOverlay @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : FrameLayout(context, attrs) {

    /** What the tour needs from the screen it is drawn over. */
    interface Host {
        fun coachTarget(targetId: Int): View?
        fun coachReveal(target: View)

        /**
         * Moves the content under the guide by [dy] pixels on screen (positive
         * is down), as far as it can scroll. Used when the step card has no
         * room beside the target.
         */
        fun coachShift(dy: Int)
        fun coachFinished(completed: Boolean)
    }

    private val density = resources.displayMetrics.density
    private val holePadding = 8f * density
    private val holeRadius = 20f * density
    private val glowWidth = 2f * density
    private val cardGap = 12f * density
    private val cardMargin = 20f * density

    private val accent: Int = run {
        val typed = context.obtainStyledAttributes(intArrayOf(R.attr.coachMarkAccent))
        try {
            typed.getColor(0, ContextCompat.getColor(context, R.color.levix_blue))
        } finally {
            typed.recycle()
        }
    }

    private val scrimPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = ContextCompat.getColor(context, R.color.coach_scrim)
    }
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeJoin = Paint.Join.ROUND
        color = accent
    }
    private val scrimPath = Path()
    private val hole = RectF()
    private val ring = RectF()
    private val safeArea = Rect()

    private val card: MaterialCardView =
        LayoutInflater.from(context).inflate(R.layout.view_coach_mark, null, false) as MaterialCardView
    private val stepLabel = card.findViewById<TextView>(R.id.coachStepLabel)
    private val titleText = card.findViewById<TextView>(R.id.coachTitle)
    private val bodyText = card.findViewById<TextView>(R.id.coachBody)
    private val skipButton = card.findViewById<MaterialButton>(R.id.coachSkip)
    private val backButton = card.findViewById<MaterialButton>(R.id.coachBack)
    private val nextButton = card.findViewById<MaterialButton>(R.id.coachNext)

    private var host: Host? = null
    private var requestedTarget: Int? = null
    private var visibleSteps: List<Int> = emptyList()
    private var cursor = 0
    private var finished = false
    private var pulse = 1f
    private var pulseAnimator: ValueAnimator? = null

    init {
        setWillNotDraw(false)
        isClickable = true
        isFocusable = true
        // The empty frame itself is not a stop for TalkBack; the card is.
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        card.visibility = View.INVISIBLE
        card.isFocusable = true
        addView(card)
        skipButton.setOnClickListener { finish(true) }
        backButton.setOnClickListener { if (cursor > 0) showStep(cursor - 1) }
        nextButton.setOnClickListener {
            if (cursor >= visibleSteps.lastIndex) finish(true) else showStep(cursor + 1)
        }
    }

    /**
     * Shows the tour. [requestedTarget] is the layout id a previous run was
     * on, so a rotation resumes the same stop instead of the first one.
     */
    fun start(host: Host, requestedTarget: Int?) {
        this.host = host
        this.requestedTarget = requestedTarget
        // Wait for the first layout so every target has real bounds, then let
        // the message queue do the work: a tour that skips everything ends by
        // removing itself, and removing a view during a layout pass is unsafe.
        doOnLayout { post { begin() } }
    }

    /** The target of the step being shown, for [android.os.Bundle] state. */
    fun currentTarget(): Int? {
        if (finished) return null
        val step = visibleSteps.getOrNull(cursor) ?: return null
        return CoachMarkGuide.steps[step].target
    }

    /** Re-measure the hole after the screen under the guide changed. */
    fun refresh() {
        if (finished) return
        val step = visibleSteps.getOrNull(cursor) ?: return
        val target = host?.coachTarget(CoachMarkGuide.steps[step].target) ?: return
        if (!visibleInHierarchy(target)) return
        locate(target)
    }

    /** System back: previous stop, or leave the tour from the first one. */
    fun goBack() {
        if (finished) return
        if (cursor > 0) showStep(cursor - 1) else finish(true)
    }

    private fun begin() {
        if (finished || !isAttachedToWindow) return
        val host = host ?: return
        val states = CoachMarkGuide.steps.map { step ->
            val target = host.coachTarget(step.target)
            CoachMarkGuide.Target(
                present = target != null,
                // Not just this view's flag: a control inside a GONE container
                // is still VISIBLE itself and would be ringed in empty space.
                visible = target != null && visibleInHierarchy(target),
                laidOut = target != null && target.isLaidOut &&
                    target.width > 0 && target.height > 0,
            )
        }
        visibleSteps = CoachMarkGuide.availableSteps(states)
        if (visibleSteps.isEmpty()) {
            finish(true)
            return
        }
        val wanted = visibleSteps.indexOfFirst {
            CoachMarkGuide.steps[it].target == requestedTarget
        }
        showStep(if (wanted >= 0) wanted else 0)
        startPulse()
    }

    private fun showStep(index: Int) {
        if (index !in visibleSteps.indices) {
            finish(true)
            return
        }
        cursor = index
        val host = host ?: return
        val step = CoachMarkGuide.steps[visibleSteps[index]]
        val target = host.coachTarget(step.target)
        // A control can leave the screen between two stops (the panel button
        // while the assistant starts). Skip it rather than ring nothing.
        if (target == null || !visibleInHierarchy(target)) {
            showStep(index + 1)
            return
        }
        host.coachReveal(target)
        renderCard(index, step)
        locate(target)
        if (makeRoomForCard(host)) locate(target)
        card.post { if (!finished) card.announceForAccessibility(announcement(index, step)) }
    }

    private fun renderCard(index: Int, step: CoachMarkGuide.Step) {
        stepLabel.text = context.getString(R.string.guide_step, index + 1, visibleSteps.size)
        titleText.setText(step.title)
        bodyText.setText(step.body)
        backButton.visibility = if (index == 0) View.GONE else View.VISIBLE
        nextButton.setText(
            if (index == visibleSteps.lastIndex) R.string.guide_done else R.string.guide_next,
        )
        card.visibility = View.VISIBLE
        card.requestLayout()
    }

    private fun announcement(index: Int, step: CoachMarkGuide.Step): CharSequence =
        context.getString(
            R.string.guide_announce,
            context.getString(step.title),
            context.getString(step.body),
            context.getString(R.string.guide_step, index + 1, visibleSteps.size),
        )

    /** Visible itself and through every ancestor: a GONE parent hides the child. */
    private fun visibleInHierarchy(view: View): Boolean {
        var current: View? = view
        while (current != null) {
            if (current.visibility != View.VISIBLE) return false
            current = current.parent as? View
        }
        return true
    }

    /** Turns the target's on-screen bounds into a padded hole in our own space. */
    private fun locate(target: View) {
        val targetLocation = IntArray(2)
        target.getLocationInWindow(targetLocation)
        val ownLocation = IntArray(2)
        getLocationInWindow(ownLocation)
        val left = (targetLocation[0] - ownLocation[0] - holePadding).toFloat()
        val top = (targetLocation[1] - ownLocation[1] - holePadding).toFloat()
        hole.set(
            left,
            top,
            left + target.width + holePadding * 2f,
            top + target.height + holePadding * 2f,
        )
        invalidate()
        requestLayout()
    }

    /**
     * [coachReveal] puts the target at the top, which leaves the card room
     * below it, unless the screen is already scrolled to its end. Then a tall
     * card fits neither below nor above and would dock over the target. Shift
     * the content by whichever distance opens room on one side. Returns
     * whether it moved anything.
     */
    private fun makeRoomForCard(host: Host): Boolean {
        if (width <= 0 || height <= 0 || hole.isEmpty) return false
        insets(safeArea)
        val margin = cardMargin.toInt()
        card.measure(
            View.MeasureSpec.makeMeasureSpec((width - margin * 2).coerceAtLeast(0), MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, MeasureSpec.AT_MOST),
        )
        val cardHeight = card.measuredHeight
        val roomAbove = hole.top - cardGap - (safeArea.top + margin)
        val roomBelow = (height - safeArea.bottom - margin) - (hole.bottom + cardGap)
        if (roomAbove >= cardHeight || roomBelow >= cardHeight) return false
        val down = cardHeight - roomAbove
        val up = cardHeight - roomBelow
        host.coachShift((if (down <= up) down else -up).toInt())
        return true
    }

    private fun startPulse() {
        if (pulseAnimator != null) return
        if (!ValueAnimator.areAnimatorsEnabled()) {
            pulse = 1f
            invalidate()
            return
        }
        pulseAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1800L
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.REVERSE
            interpolator = AccelerateDecelerateInterpolator()
            addUpdateListener {
                pulse = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    private fun stopPulse() {
        pulseAnimator?.cancel()
        pulseAnimator = null
        pulse = 1f
    }

    private fun finish(completed: Boolean) {
        if (finished) return
        finished = true
        stopPulse()
        card.visibility = View.INVISIBLE
        host?.coachFinished(completed)
    }

    override fun onDetachedFromWindow() {
        stopPulse()
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        val width = width.toFloat()
        val height = height.toFloat()
        if (width <= 0f || height <= 0f) return
        scrimPath.reset()
        scrimPath.fillType = Path.FillType.EVEN_ODD
        scrimPath.addRect(0f, 0f, width, height, Path.Direction.CW)
        if (!hole.isEmpty) {
            scrimPath.addRoundRect(hole, holeRadius, holeRadius, Path.Direction.CW)
        }
        canvas.drawPath(scrimPath, scrimPaint)
        if (!hole.isEmpty) drawGlow(canvas)
    }

    /** Concentric strokes, widening and fading outward, so the edge stays soft. */
    private fun drawGlow(canvas: Canvas) {
        val strength = 0.55f + 0.45f * pulse
        glowPaint.color = accent
        drawRing(canvas, glowWidth * 6f, (26 * strength).toInt())
        drawRing(canvas, glowWidth * 3f, (70 * strength).toInt())
        drawRing(canvas, glowWidth, (215 * strength).toInt().coerceAtMost(255))
    }

    private fun drawRing(canvas: Canvas, width: Float, alpha: Int) {
        val inset = width / 2f
        ring.set(hole.left - inset, hole.top - inset, hole.right + inset, hole.bottom + inset)
        glowPaint.strokeWidth = width
        glowPaint.alpha = alpha
        val radius = holeRadius + inset
        canvas.drawRoundRect(ring, radius, radius, glowPaint)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        val width = right - left
        val height = bottom - top
        if (width <= 0 || height <= 0) return
        insets(safeArea)
        val margin = cardMargin.toInt()
        val cardWidth = (width - margin * 2).coerceAtLeast(0)
        card.measure(
            View.MeasureSpec.makeMeasureSpec(cardWidth, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.AT_MOST),
        )
        val cardHeight = card.measuredHeight
        val topPadding = safeArea.top + margin
        val bottomLimit = height - safeArea.bottom - margin
        val preferred: Float = if (hole.isEmpty) {
            (bottomLimit - cardHeight).toFloat()
        } else {
            val below = hole.bottom + cardGap
            val above = hole.top - cardGap - cardHeight
            when {
                below + cardHeight <= bottomLimit.toFloat() -> below
                above >= topPadding.toFloat() -> above
                else -> (bottomLimit - cardHeight).toFloat()
            }
        }
        val maxTop = (bottomLimit - cardHeight).coerceAtLeast(topPadding)
        val cardTop = preferred.toInt().coerceIn(topPadding, maxTop)
        card.layout(margin, cardTop, margin + cardWidth, cardTop + cardHeight)
    }

    private fun insets(out: Rect) {
        val bars = ViewCompat.getRootWindowInsets(this)?.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        if (bars == null) out.setEmpty() else out.set(bars.left, bars.top, bars.right, bars.bottom)
    }
}
