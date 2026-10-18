package net.leviro.levix

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.graphics.Color
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * The first-run guide: what to press, in order, with a picture of the screen it
 * is talking about. It is the same list whether it runs on first launch or from
 * "Show guide again", so the two can never drift apart.
 */
class OnboardingActivity : AppCompatActivity() {
    private var step = 0
    private var replay = false

    private val stepArt = intArrayOf(
        R.drawable.guide_step_start,
        R.drawable.guide_step_battery,
        R.drawable.guide_step_panel,
        R.drawable.guide_step_link,
        R.drawable.guide_step_privacy,
    )
    private val stepTitle = intArrayOf(
        R.string.guide_start_title,
        R.string.guide_battery_title,
        R.string.guide_panel_title,
        R.string.guide_link_title,
        R.string.guide_privacy_title,
    )
    private val stepBody = intArrayOf(
        R.string.guide_start_body,
        R.string.guide_battery_body,
        R.string.guide_panel_body,
        R.string.guide_link_body,
        R.string.guide_privacy_body,
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        setContentView(R.layout.activity_onboarding)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        replay = intent.getBooleanExtra(EXTRA_REPLAY, false)
        step = savedInstanceState?.getInt("step") ?: 0
        addStepDots()
        findViewById<Button>(R.id.guideSkip).setOnClickListener { complete() }
        findViewById<Button>(R.id.guideBack).setOnClickListener {
            if (step > 0) {
                step--
                render()
            }
        }
        findViewById<Button>(R.id.guideNext).setOnClickListener {
            if (step == stepArt.lastIndex) complete() else { step++; render() }
        }
        render()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt("step", step)
        super.onSaveInstanceState(outState)
    }

    /** One dot per step, built here so a new step cannot be forgotten in XML. */
    private fun addStepDots() {
        val dots = findViewById<LinearLayout>(R.id.guideDots)
        val size = resources.getDimensionPixelSize(R.dimen.guide_dot_size)
        val gap = resources.getDimensionPixelSize(R.dimen.guide_dot_gap)
        for (index in stepArt.indices) {
            val dot = View(this)
            val params = LinearLayout.LayoutParams(size, size)
            if (index > 0) params.marginStart = gap
            dot.layoutParams = params
            dots.addView(dot)
        }
    }

    private fun render() {
        val dots = findViewById<LinearLayout>(R.id.guideDots)
        for (index in 0 until dots.childCount) {
            dots.getChildAt(index).setBackgroundResource(
                if (index == step) R.drawable.bg_dot_on else R.drawable.bg_dot_off,
            )
        }
        findViewById<TextView>(R.id.guideProgress).text = getString(R.string.guide_step, step + 1)
        findViewById<ImageView>(R.id.guideArt).setImageResource(stepArt[step])
        findViewById<TextView>(R.id.guideTitle).setText(stepTitle[step])
        findViewById<TextView>(R.id.guideBody).setText(stepBody[step])
        findViewById<Button>(R.id.guideBack)
            .visibility = if (step == 0) View.GONE else View.VISIBLE
        findViewById<Button>(R.id.guideNext).setText(
            if (step == stepArt.lastIndex) R.string.guide_done else R.string.guide_next,
        )
    }

    private fun complete() {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_COMPLETED, true).apply()
        if (!replay) startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    companion object {
        private const val PREFS = "levix_onboarding"
        private const val KEY_COMPLETED = "onboarding_completed"
        private const val EXTRA_REPLAY = "replay"

        fun completed(context: Context): Boolean = context.getSharedPreferences(PREFS,
            Context.MODE_PRIVATE).getBoolean(KEY_COMPLETED, false)

        fun showAgain(context: Context) {
            context.startActivity(Intent(context, OnboardingActivity::class.java)
                .putExtra(EXTRA_REPLAY, true))
        }
    }
}
