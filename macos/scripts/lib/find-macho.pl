#!/usr/bin/perl
# Prints NUL-separated paths of every Mach-O file under the given roots, deepest paths first.
# Detects by magic bytes (not by extension) so .node, .dylib, .so and bare executables are all found.
use strict;
use warnings;
use File::Find;

my %magic = map { $_ => 1 } ("\xfe\xed\xfa\xce", "\xfe\xed\xfa\xcf", "\xce\xfa\xed\xfe", "\xcf\xfa\xed\xfe");
my @found;
find({ no_chdir => 1, wanted => sub {
    return if -l $File::Find::name || !-f _;
    return if -s _ < 8;
    open(my $fh, '<:raw', $File::Find::name) or return;
    my $n = read($fh, my $head, 8);
    close $fh;
    return unless $n == 8;
    my $m = substr($head, 0, 4);
    if ($magic{$m}) { push @found, $File::Find::name; return; }
    # Universal binary: cafebabe + a small arch count (Java class files have a large value here).
    if ($m eq "\xca\xfe\xba\xbe" || $m eq "\xbe\xba\xfe\xca") {
        my $count = $m eq "\xca\xfe\xba\xbe" ? unpack('N', substr($head, 4, 4)) : unpack('V', substr($head, 4, 4));
        push @found, $File::Find::name if $count > 0 && $count < 20;
    }
}}, @ARGV);
my %seen;
@found = grep { !$seen{$_}++ } @found;
# Deepest first, so anything nested is signed before what contains it.
@found = sort { (($b =~ tr{/}{}) <=> ($a =~ tr{/}{})) || ($a cmp $b) } @found;
print join("\0", @found), (@found ? "\0" : "");
