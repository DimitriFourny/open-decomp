export const ENCODINGS = [
    {
        "instructionId": "ld1q_z_p_ar",
        "encodingId": "ld1q_z_p_ar_d_64_unscaled",
        "mnemonic": "LD1Q",
        "className": "SVE2",
        "fileName": "ld1q_z_p_ar.xml",
        "mask": 4292927488,
        "value": 3288375296,
        "bitCount": 14,
        "fields": [
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-contiguous-memory"
    }
];
